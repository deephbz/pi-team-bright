import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json";
import { withLock } from "./lock";
import { validPtbModelRoleNames, validatePtbSettingsNamespace } from "./model-role-settings";

/** Edits only Pi Team Bright's namespace in Pi settings. Live Teams keep their epoch settings. */
export type PtbSettingsScope = "global" | "project";
export type PtbSettingsEditorErrorCode =
  | "untrusted_project" | "invalid_settings" | "concurrent_change" | "stale_context" | "read_failed" | "write_failed";

export class PtbSettingsEditorError extends Error {
  constructor(readonly code: PtbSettingsEditorErrorCode, message: string) {
    super(message);
    this.name = "PtbSettingsEditorError";
  }
}

export interface PtbSettingsDocument {
  file: string;
  scope: PtbSettingsScope;
  namespace: unknown;
  revision: string;
  /** The global source used when a project default refers to an inherited role. */
  globalFile?: string;
}

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readSettingsFile(file: string): { root: Record<string, unknown>; revision: string } {
  let fd: number | undefined;
  try {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) {
        throw new PtbSettingsEditorError("invalid_settings", "Pi settings must not be a symbolic link.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) {
      throw new PtbSettingsEditorError("invalid_settings", "Pi settings must be a regular file no larger than 2 MiB.");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SETTINGS_BYTES + 1 - total));
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      total += length;
      if (total > MAX_SETTINGS_BYTES) {
        throw new PtbSettingsEditorError("invalid_settings", "Pi settings exceed the 2 MiB editor limit.");
      }
      chunks.push(chunk.subarray(0, length));
    }
    const bytes = Buffer.concat(chunks);
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); }
    catch { throw new PtbSettingsEditorError("invalid_settings", "Pi settings contain malformed JSON."); }
    if (!isRecord(parsed)) throw new PtbSettingsEditorError("invalid_settings", "Pi settings root must be an object.");
    return { root: parsed, revision: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root: {}, revision: "missing" };
    if (error instanceof PtbSettingsEditorError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new PtbSettingsEditorError("invalid_settings", "Pi settings must not be a symbolic link.");
    }
    throw new PtbSettingsEditorError("read_failed", "Pi settings could not be read.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function namespaceFrom(root: Record<string, unknown>): unknown {
  return Object.hasOwn(root, "pi_team_bright") ? root.pi_team_bright : {};
}

export function readPtbSettingsDocument(input: {
  cwd: string;
  projectTrusted: boolean;
  scope: PtbSettingsScope;
  agentDir?: string;
}): PtbSettingsDocument {
  if (input.scope === "project" && !input.projectTrusted) {
    throw new PtbSettingsEditorError("untrusted_project", "Project settings require a trusted Pi project.");
  }
  const globalFile = path.join(path.resolve(input.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")), "settings.json");
  const file = input.scope === "global" ? globalFile : path.join(path.resolve(input.cwd), ".pi", "settings.json");
  const observed = readSettingsFile(file);
  return {
    file,
    scope: input.scope,
    namespace: namespaceFrom(observed.root),
    revision: observed.revision,
    ...(input.scope === "project" ? { globalFile } : {}),
  };
}

function candidateNamespace(document: PtbSettingsDocument, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new PtbSettingsEditorError("invalid_settings", "pi_team_bright must be an object.");
  let raw: string | undefined;
  try { raw = JSON.stringify(value); }
  catch { throw new PtbSettingsEditorError("invalid_settings", "pi_team_bright must contain JSON settings."); }
  if (raw === undefined) throw new PtbSettingsEditorError("invalid_settings", "pi_team_bright must contain JSON settings.");
  if (Buffer.byteLength(raw, "utf8") > MAX_SETTINGS_BYTES) {
    throw new PtbSettingsEditorError("invalid_settings", "pi_team_bright exceeds the 2 MiB editor limit.");
  }
  let inheritedRoleNames: ReadonlySet<string> | undefined;
  if (document.scope === "project" && document.globalFile) {
    try {
      const globalNamespace = namespaceFrom(readSettingsFile(document.globalFile).root);
      inheritedRoleNames = validPtbModelRoleNames(globalNamespace, "global", document.globalFile);
    } catch {
      // No inherited name is verified by an unreadable or malformed global source.
    }
  }
  const diagnostics = validatePtbSettingsNamespace(value, {
    source: document.scope,
    file: document.file,
    ...(inheritedRoleNames ? { inheritedRoleNames } : {}),
  });
  if (diagnostics.length) {
    throw new PtbSettingsEditorError("invalid_settings", diagnostics.map(item => item.message).join(" "));
  }
  const candidate: unknown = JSON.parse(raw);
  if (!isRecord(candidate)) throw new PtbSettingsEditorError("invalid_settings", "pi_team_bright must be an object.");
  const serializedDiagnostics = validatePtbSettingsNamespace(candidate, {
    source: document.scope,
    file: document.file,
    ...(inheritedRoleNames ? { inheritedRoleNames } : {}),
  });
  if (serializedDiagnostics.length) {
    throw new PtbSettingsEditorError("invalid_settings", serializedDiagnostics.map(item => item.message).join(" "));
  }
  return candidate;
}

/** Reread before atomic replacement. The lock serializes cooperating editor writes. */
export async function savePtbSettingsDocument(
  document: PtbSettingsDocument,
  namespace: unknown,
  options: { isCurrent?: () => boolean } = {},
): Promise<PtbSettingsDocument> {
  try {
    return await withLock(document.file, async () => {
      const current = readSettingsFile(document.file);
      if (current.revision !== document.revision) {
        throw new PtbSettingsEditorError("concurrent_change", "Pi settings changed after they were opened. Reload before saving.");
      }
      const candidate = candidateNamespace(document, namespace);
      const updated = { ...current.root, pi_team_bright: candidate };
      const serialized = JSON.stringify(updated, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > MAX_SETTINGS_BYTES) {
        throw new PtbSettingsEditorError("invalid_settings", "Pi settings would exceed the 2 MiB editor limit.");
      }
      try {
        if (options.isCurrent && !options.isCurrent()) {
          throw new PtbSettingsEditorError("stale_context", "The Pi Session or Team changed. Reopen settings before saving.");
        }
      } catch {
        throw new PtbSettingsEditorError("stale_context", "The Pi Session or Team changed. Reopen settings before saving.");
      }
      try { writeJsonAtomic(document.file, updated); }
      catch { throw new PtbSettingsEditorError("write_failed", "Pi settings could not be saved."); }
      const revision = `sha256:${crypto.createHash("sha256").update(serialized).digest("hex")}`;
      return { ...document, namespace: candidate, revision };
    });
  } catch (error) {
    if (error instanceof PtbSettingsEditorError) throw error;
    throw new PtbSettingsEditorError("write_failed", "Pi settings could not be saved.");
  }
}
