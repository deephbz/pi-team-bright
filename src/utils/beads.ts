import { execFile, spawn } from "node:child_process";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";

import type { BeadsAuthorityFingerprint } from "../team-authority/contracts";
import type { TaskRelation, TaskRelationType, TaskStatus } from "../task-authority/contracts";
export interface TaskAuthorityRecord {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  design?: string;
  status: TaskStatus;
  assignee?: string;
  notes?: string;
  relations: TaskRelation[];
  /** Active outgoing blocking dependencies from the same hydrated authority read. */
  activeBlockerIds?: string[];
  version: string;
  provenance: {
    authority: "beads";
    teamName: string;
  };
}

export type TaskAuthorityListItem = Omit<TaskAuthorityRecord, "version">;
import { TASK_CARD_CONTEXT_MAX_LENGTH, TASK_CARD_GOAL_MAX_LENGTH, isTaskCardContext, isTaskCardGoal } from "../task-authority/task-domain";
import { withLock } from "./lock";
import { teamDir, sanitizeName } from "./paths";
import { runHook } from "./hooks";
import crypto from "node:crypto";
import { recordBdCall, recordBdRunnerLifecycle } from "./trace";

export const DEFAULT_BD_TIMEOUT_MS = 10_000;
export const DEFAULT_BD_INIT_TIMEOUT_MS = 30_000;
export const PI_TEAMS_SCHEMA = "1";
export const TASK_METADATA_KEY = "pi_teams_task";
export const TASK_METADATA_SCHEMA = "pi-teams-task/1" as const;
/** Task-card limits are owned by the neutral domain module. */
export { TASK_CARD_CONTEXT_MAX_LENGTH, TASK_CARD_GOAL_MAX_LENGTH } from "../task-authority/task-domain";

/** Reject invalid canonical context before a Beads command can mutate it. */
export function assertTaskMetadataContext(value: unknown): asserts value is TaskMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isTaskCardContext((value as Record<string, unknown>).current_context)) {
    throw new Error(`Task current_context must contain 1 to ${TASK_CARD_CONTEXT_MAX_LENGTH.toLocaleString("en-US")} TypeBox string-length units.`);
  }
  const goal = (value as Record<string, unknown>).goal;
  if (goal !== undefined && !isTaskCardGoal(goal)) {
    throw new Error(`Task goal must contain 1 to ${TASK_CARD_GOAL_MAX_LENGTH.toLocaleString("en-US")} TypeBox string-length units.`);
  }
}

export interface TaskOperationRecord {
  operation_id: string;
  fingerprint: string;
  journal_entries: Array<{ id: string; at: string; actor: string; kind: "progress" | "decision" | "blocker" | "result" | "note"; text: string }>;
}

export interface TaskMetadata {
  schema: typeof TASK_METADATA_SCHEMA;
  goal: string;
  current_context: string;
  last_operation?: TaskOperationRecord;
}

export interface TaskAuthorityRecordEnvelope {
  task: TaskAuthorityRecord;
  taskMetadata?: unknown;
  /** Adapter-only owner-transition marker; never enters a TaskCard. */
  ownerTransitionOperationId?: string;
}

/** Internal adapter evidence. It is intentionally excluded from Task metadata. */
export const OWNER_TRANSITION_OPERATION_METADATA = "pi_teams_owner_transition_operation";

/**
 * Fail closed unless `workspace` itself is an initialized Beads 1.1 authority
 * root. `bd --directory` searches ancestors, so checking only command success
 * can silently bind a child path to the wrong database.
 */
export function readBeadsAuthorityFingerprint(workspace: string): BeadsAuthorityFingerprint {
  if (!path.isAbsolute(workspace)) throw new Error(`Beads task workspace must be an absolute path: ${workspace}`);
  const markerDir = path.join(workspace, ".beads");
  const metadataPath = path.join(markerDir, "metadata.json");
  try {
    if (!fs.statSync(workspace).isDirectory()) throw new Error("workspace is not a directory");
    if (!fs.statSync(markerDir).isDirectory()) throw new Error(".beads is not a directory");
    if (!fs.statSync(metadataPath).isFile()) throw new Error(".beads/metadata.json is not a file");
  } catch (error) {
    throw new Error(
      `Beads workspace ${workspace} is not an initialized authority root: expected ${metadataPath} at that exact workspace (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Beads workspace ${workspace} has unreadable authority metadata at ${metadataPath}: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (
    metadata.backend !== "dolt"
    || metadata.database !== "dolt"
    || typeof metadata.dolt_database !== "string"
    || !metadata.dolt_database
    || typeof metadata.project_id !== "string"
    || !metadata.project_id
  ) {
    throw new Error(`Beads workspace ${workspace} has invalid Beads 1.1 authority metadata at ${metadataPath}; refusing ancestor discovery or an ambiguous database binding.`);
  }
  return {
    schema: "pi-teams-beads-authority/1",
    backend: "dolt",
    database: "dolt",
    doltDatabase: metadata.dolt_database as string,
    projectId: metadata.project_id as string,
  };
}

export function assertBeadsWorkspaceRoot(workspace: string): void {
  readBeadsAuthorityFingerprint(workspace);
}

export function assertBeadsAuthorityFingerprint(
  workspace: string,
  expected: BeadsAuthorityFingerprint,
): BeadsAuthorityFingerprint {
  const actual = readBeadsAuthorityFingerprint(workspace);
  const fields: Array<keyof BeadsAuthorityFingerprint> = ["schema", "backend", "database", "doltDatabase", "projectId"];
  const mismatches = fields.filter((field) => actual[field] !== expected[field]);
  if (mismatches.length > 0) {
    throw new Error(
      `Beads authority fingerprint mismatch at ${workspace} (${mismatches.join(", ")}); refusing to bind the Team to a replaced or different database.`,
    );
  }
  return actual;
}

export interface BdCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BdRunner {
  run(args: string[], options: { cwd: string; timeoutMs: number }): Promise<BdCommandResult>;
}

export class OwnedBdBinaryError extends Error {
  readonly code: "BEADS_OWNED_BINARY_MISSING" | "BEADS_OWNED_BINARY_UNSUPPORTED";

  constructor(
    code: OwnedBdBinaryError["code"],
    message: string,
  ) {
    super(message);
    this.name = "OwnedBdBinaryError";
    this.code = code;
  }
}

/**
 * Resolve the owned Beads CLI directly from this package's dependency graph.
 * Pi launches extensions from a parent process whose PATH need not include the
 * package's `node_modules/.bin`; invoking its platform-native binary avoids
 * silently binding Task authority to an unrelated global `bd` version or a
 * launcher process. The native binary is acquired by @beads/bd postinstall
 * (or deliberately materialized by CI).
 */
export function resolveBdExecutable(): string {
  try {
    const manifestPath = require.resolve("@beads/bd/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { bin?: { bd?: unknown } | unknown };
    const bin = typeof manifest.bin === "object" && manifest.bin !== null
      ? (manifest.bin as { bd?: unknown }).bd
      : undefined;
    if (typeof bin !== "string" || !bin) throw new OwnedBdBinaryError(
      "BEADS_OWNED_BINARY_MISSING",
      "owned @beads/bd package does not declare the bd launcher",
    );

    const packageRoot = path.dirname(manifestPath);
    const launcher = path.resolve(packageRoot, bin);
    if (!fs.statSync(launcher).isFile()) throw new OwnedBdBinaryError(
      "BEADS_OWNED_BINARY_MISSING",
      `owned @beads/bd launcher is missing at ${launcher}`,
    );

    if (!["darwin", "linux", "win32", "android"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
      throw new OwnedBdBinaryError(
        "BEADS_OWNED_BINARY_UNSUPPORTED",
        `owned @beads/bd binary is unsupported on ${process.platform}-${process.arch}`,
      );
    }
    const nativeBinary = path.join(packageRoot, "bin", process.platform === "win32" ? "bd.exe" : "bd");
    if (!fs.statSync(nativeBinary).isFile()) throw new OwnedBdBinaryError(
      "BEADS_OWNED_BINARY_MISSING",
      `owned @beads/bd binary is missing at ${nativeBinary}; reinstall @beads/bd@1.1.0 for ${process.platform}-${process.arch}`,
    );
    return nativeBinary;
  } catch (error) {
    if (error instanceof OwnedBdBinaryError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new OwnedBdBinaryError(
      "BEADS_OWNED_BINARY_MISSING",
      `unable to resolve owned @beads/bd launcher; reinstall @beads/bd@1.1.0 (${reason})`,
    );
  }
}

export function bdExecFailure(error: any): BdCommandResult {
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  const ownedBinaryMissing = error?.code === "BEADS_OWNED_BINARY_MISSING" || error?.code === "BEADS_OWNED_BINARY_UNSUPPORTED";
  const commandMissing = error?.code === "ENOENT";
  const stderr = typeof error?.stderr === "string" && error.stderr
    ? error.stderr
    : ownedBinaryMissing
      ? `bd: ${error.message}`
      : commandMissing
        ? "bd: command not found"
        : "";
  const timedOut = error?.killed || error?.code === "ETIMEDOUT";
  const exitCode = ownedBinaryMissing || commandMissing ? 127 : typeof error?.code === "number" ? error.code : timedOut ? 124 : 1;
  return { stdout, stderr, exitCode };
}

export class ExecBdRunner implements BdRunner {
  constructor(private readonly executable: () => string = resolveBdExecutable) {}

  async run(args: string[], options: { cwd: string; timeoutMs: number }): Promise<BdCommandResult> {
    const startedAt = Date.now();
    try {
      const executable = this.executable();
      return await new Promise<BdCommandResult>((resolve) => {
        const child = spawn(executable, args, {
          cwd: options.cwd,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let outputLimitExceeded = false;
        let settled = false;
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: BdCommandResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (cleanupTimer) clearTimeout(cleanupTimer);
          if (timedOut || outputLimitExceeded) {
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
          }
          recordBdRunnerLifecycle("settled", Date.now() - startedAt, timedOut);
          resolve(result);
        };
        const terminate = async (signal: NodeJS.Signals): Promise<void> => {
          if (process.platform === "win32") {
            await new Promise<void>((resolve) => {
              if (!child.pid) return resolve();
              execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], (error) => {
                if (error) child.kill(signal);
                resolve();
              });
            });
          } else if (child.pid) {
            try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
          } else child.kill(signal);
        };
        const appendOutput = (target: "stdout" | "stderr", chunk: string) => {
          if (outputLimitExceeded) return;
          const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
          const remaining = 8 * 1024 * 1024 - used;
          const bytes = Buffer.byteLength(chunk);
          const value = bytes <= remaining ? chunk : Buffer.from(chunk).subarray(0, Math.max(0, remaining)).toString("utf8");
          if (target === "stdout") stdout += value;
          else stderr += value;
          if (bytes > remaining) {
            outputLimitExceeded = true;
            void terminate("SIGKILL").finally(() => finish({ stdout, stderr, exitCode: 1 }));
          }
        };
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => appendOutput("stdout", chunk));
        child.stderr.on("data", (chunk: string) => appendOutput("stderr", chunk));
        child.once("error", (error) => finish(bdExecFailure(error)));
        child.once("close", (code) => finish({ stdout, stderr, exitCode: timedOut ? 124 : code ?? 1 }));
        recordBdRunnerLifecycle("start", 0, false);
        const deadline = setTimeout(() => {
          timedOut = true;
          recordBdRunnerLifecycle("deadline", Date.now() - startedAt, true);
          void terminate("SIGTERM").finally(() => {
            recordBdRunnerLifecycle("termination_cleanup", Date.now() - startedAt, true);
            cleanupTimer = setTimeout(() => {
              void terminate("SIGKILL").finally(() => finish({ stdout, stderr, exitCode: 124 }));
            }, 100);
          });
        }, Math.max(0, options.timeoutMs));
      });
    } catch (error: any) {
      return bdExecFailure(error);
    }
  }
}

export const defaultBdRunner: BdRunner = new ExecBdRunner();

/**
 * Initialize a dedicated Beads authority root without generating agent files
 * or repository hooks. A valid existing root is preserved, which lets a
 * Team-creation retry recover after `bd init` succeeded but TeamConfig did not.
 */
export async function initializeBeadsWorkspace(
  workspace: string,
  runner: BdRunner = defaultBdRunner,
): Promise<BeadsAuthorityFingerprint> {
  if (!path.isAbsolute(workspace)) throw new Error(`Beads task workspace must be an absolute path: ${workspace}`);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });

  const metadataPath = path.join(workspace, ".beads", "metadata.json");
  if (!fs.existsSync(metadataPath)) {
    const args = ["init", "--quiet", "--non-interactive", "--skip-agents", "--skip-hooks", "--init-if-missing"];
    const startedAt = Date.now();
    const result = await runner.run(args, { cwd: workspace, timeoutMs: DEFAULT_BD_INIT_TIMEOUT_MS });
    recordBdCall("init", Date.now() - startedAt, result.exitCode === 0 ? "ok" : "error");
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const kind = result.exitCode === 127 ? "unavailable" : result.exitCode === 124 ? "timeout" : "command";
      throw new BeadsError(
        `Unable to initialize the Team-owned Beads workspace ${workspace}${stderr ? `: ${stderr}` : "."}`,
        kind,
        `bd ${args.join(" ")}`,
        stderr || undefined,
      );
    }
  }

  return readBeadsAuthorityFingerprint(workspace);
}

export class BeadsError extends Error {
  readonly kind: "unavailable" | "timeout" | "command" | "malformed" | "scope" | "conflict";
  readonly command: string;
  readonly stderr?: string;

  constructor(
    message: string,
    kind: BeadsError["kind"],
    command: string,
    stderr?: string,
  ) {
    super(message);
    this.name = "BeadsError";
    this.kind = kind;
    this.command = command;
    this.stderr = stderr;
  }
}

interface RawBead {
  id: string;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  design?: string;
  notes?: string;
  parent?: string;
  status: "open" | "in_progress" | "blocked" | "deferred" | "closed";
  assignee?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
  updated_at?: string;
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
  dependencies?: Array<{ id?: string; issue_id?: string; depends_on_id?: string; dependency_type?: string; type?: string; status?: string }>;
  dependents?: Array<{ id?: string; issue_id?: string; depends_on_id?: string; dependency_type?: string; type?: string; status?: string }>;
  comments?: Array<{ id: string; author: string; text: string; created_at: string }>;
  error?: string;
}

export interface BeadsReadyDispatchSnapshot {
  readyTasks: TaskAuthorityRecordEnvelope[];
  occupiedWorkers: string[];
}

export interface BeadsTaskStoreOptions {
  teamName: string;
  workspace: string;
  actor?: string;
  timeoutMs?: number;
  runner?: BdRunner;
  authorityFingerprint?: BeadsAuthorityFingerprint;
  /** Enforced by the post-cutover task factory; migration can explicitly disable it. */
  requireExpectedVersion?: boolean;
}

export interface TaskWriteOptions {
  actor?: string;
  expectedVersion?: string;
  idempotencyKey?: string;
  /** Semantic payload combined into the same native Beads update command. */
  appendNote?: string;
  /** Internal candidate projection committed with the same native update. */
  taskMetadata?: TaskMetadata;
  retries?: number;
  /** Internal precommit hook; never part of the agent-facing Task contract. */
  internalOwnerTransition?: {
    operationId: string;
    prepare(before: TaskAuthorityRecordEnvelope, previousOperationId?: string): Promise<boolean>;
  };
}

export interface CreateTaskInput {
  title: string;
  description: string;
  acceptanceCriteria?: string;
  design?: string;
  assignee?: string;
  idempotencyKey?: string;
  /** Migration-only metadata; never exposed by the agent-facing create tool. */
  internalMetadata?: Record<string, unknown>;
}

export interface BeadsTaskLink {
  relation: TaskRelationType;
  targetId: string;
  action: "add" | "remove";
}

export interface TaskMutationResult {
  before: TaskAuthorityRecord;
  after: TaskAuthorityRecord;
  /** Raw envelopes from the same authority reads that produced before/after. */
  beforeEnvelope?: TaskAuthorityRecordEnvelope;
  afterEnvelope?: TaskAuthorityRecordEnvelope;
  appliedOperations: string[];
}

/** Result of a create, including whether an idempotency replay supplied the Task. */
export interface TaskCreateResult {
  task: TaskAuthorityRecord;
  /** Raw envelope from the committed create/replay read. */
  taskEnvelope?: TaskAuthorityRecordEnvelope;
  replayed: boolean;
}

export interface BeadsGraphCreateInput {
  operationId: string;
  fingerprint: string;
  nodes: Array<CreateTaskInput & { key: string }>;
  edges: Array<{
    from: { key: string } | { id: string };
    to: { key: string } | { id: string };
  }>;
}

export interface BeadsGraphCreateResult {
  tasksByKey: Record<string, TaskAuthorityRecordEnvelope>;
  replayed: boolean;
}

export interface BeadsGraphOperationReceipt {
  fingerprint: string;
  tasksByKey: Record<string, TaskAuthorityRecordEnvelope>;
}

export function beadsLabel(teamName: string): string {
  return `pi-teams:${sanitizeName(teamName)}`;
}

function actorName(actor?: string): string {
  return actor || process.env.PI_AGENT_NAME || process.env.BEADS_ACTOR || "pi-teams";
}

function metadataValue(raw: RawBead, key: string): string | undefined {
  const value = raw.metadata?.[key];
  return typeof value === "string" ? value : value == null ? undefined : JSON.stringify(value);
}

function dependencyId(dependency: NonNullable<RawBead["dependencies"]>[number]): string | undefined {
  return dependency.id || dependency.depends_on_id || dependency.issue_id;
}

function dependencyType(dependency: NonNullable<RawBead["dependencies"]>[number]): string {
  return dependency.dependency_type || dependency.type || "blocks";
}

function mapStatus(raw: RawBead): TaskAuthorityRecord["status"] {
  if (raw.status === "closed") return "closed";
  if (raw.status === "in_progress") return "in_progress";
  if (raw.status === "blocked") return "blocked";
  if (raw.status === "deferred") {
    throw new BeadsError(
      `Task ${raw.id} has unsupported authoritative Beads status 'deferred'; refusing to misreport it as open.`,
      "scope",
      `bd show ${raw.id}`,
    );
  }
  return "open";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableValue(nested)]));
}

function authorityVersion(raw: RawBead): string {
  // Conditional writes use hydrated `bd show` records, so include relation
  // identities rather than only their counts. This makes review of Task@vN
  // fail closed even if one edge is replaced by another in the same second.
  const count = (explicit: number | undefined, hydrated: unknown[] | undefined): number => {
    if (typeof explicit === "number" && Number.isSafeInteger(explicit) && explicit >= 0) return explicit;
    return hydrated?.length || 0;
  };
  const canonical = {
    id: raw.id,
    title: raw.title,
    description: raw.description || "",
    acceptanceCriteria: raw.acceptance_criteria || "",
    design: raw.design || "",
    notes: raw.notes || "",
    parent: raw.parent || "",
    status: raw.status,
    revisionSecond: (() => {
      const parsed = Date.parse(raw.updated_at || "");
      return Number.isFinite(parsed)
        ? new Date(Math.floor(parsed / 1000) * 1000).toISOString()
        : raw.updated_at || "";
    })(),
    assignee: raw.assignee || "",
    labels: [...(raw.labels || [])].sort(),
    metadata: stableValue(raw.metadata || {}),
    dependencyCount: count(raw.dependency_count, raw.dependencies),
    dependentCount: count(raw.dependent_count, raw.dependents),
    commentCount: count(raw.comment_count, raw.comments),
    dependencies: stableValue(raw.dependencies || []),
    dependents: stableValue(raw.dependents || []),
  };
  return `beads_${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function mapTask(raw: RawBead): TaskAuthorityRecord {
  const relationFromDependency = (dependency: NonNullable<RawBead["dependencies"]>[number]): TaskRelation[] => {
    const targetId = dependencyId(dependency);
    if (!targetId) return [];
    const type = dependencyType(dependency);
    if (type === "blocks") return [{ relation: "blocked_by" as const, targetId }];
    if (type === "parent-child") return [{ relation: "parent" as const, targetId }];
    if (type === "relates-to" || type === "related" || type === "relates_to") return [{ relation: "related" as const, targetId }];
    return [];
  };
  const relations: TaskRelation[] = [
    ...(raw.dependencies || []).flatMap(relationFromDependency),
    ...(raw.dependents || []).flatMap((dependency) => {
      const type = dependencyType(dependency);
      return type === "relates-to" || type === "related" || type === "relates_to" ? relationFromDependency(dependency) : [];
    }),
  ].filter((relation, index, all) => all.findIndex((candidate) => candidate.relation === relation.relation && candidate.targetId === relation.targetId) === index);
  if (raw.parent && !relations.some((relation) => relation.relation === "parent" && relation.targetId === raw.parent)) {
    relations.push({ relation: "parent", targetId: raw.parent });
  }
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description || "",
    acceptanceCriteria: raw.acceptance_criteria || "",
    design: raw.design || undefined,
    status: mapStatus(raw),
    assignee: raw.assignee,
    notes: raw.notes || undefined,
    relations,
    activeBlockerIds: (raw.dependencies || []).flatMap((dependency) => {
      const targetId = dependencyId(dependency);
      return targetId && dependencyType(dependency) === "blocks" && dependency.status !== "closed" ? [targetId] : [];
    }).sort(),
    version: authorityVersion(raw),
    provenance: { authority: "beads", teamName: metadataValue(raw, "pi_teams_team") || "unknown" },
  };
}

function mapWithReverseDependencies(raws: RawBead[]): TaskAuthorityRecord[] {
  return raws.map(mapTask);
}

function parseJson<T>(result: BdCommandResult, command: string): T {
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const commandDetail = stderr || result.stdout.trim();
    const lower = `${stderr} ${result.stdout}`.toLowerCase();
    const kind = result.exitCode === 124 || lower.includes("timed out") || lower.includes("timeout")
      ? "timeout"
      : result.exitCode === 127 || lower.includes("not found") || lower.includes("no such file")
        ? "unavailable"
        : "command";
    throw new BeadsError(
      `Beads command failed (${kind}): ${command}${commandDetail ? ` — ${commandDetail.slice(0, 500)}` : ""}. ` +
        "Check that bd is installed and the configured workspace contains an initialized Beads repository.",
      kind,
      command,
      commandDetail || undefined,
    );
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
      throw new Error(String((parsed as { error: unknown }).error));
    }
    return parsed as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BeadsError(
      `Beads returned malformed JSON for ${command}: ${detail}. Raw output was: ${result.stdout.slice(0, 500)}`,
      "malformed",
      command,
      result.stderr.trim() || undefined,
    );
  }
}

export class BeadsTaskStore {
  readonly teamName: string;
  readonly workspace: string;
  private readonly actor: string;
  private readonly timeoutMs: number;
  private readonly runner: BdRunner;
  private readonly requireExpectedVersion: boolean;
  private readonly authorityFingerprint?: BeadsAuthorityFingerprint;

  constructor(options: BeadsTaskStoreOptions) {
    if (!path.isAbsolute(options.workspace)) {
      throw new Error(`Beads task workspace must be an absolute path: ${options.workspace}`);
    }
    this.teamName = sanitizeName(options.teamName);
    this.workspace = options.workspace;
    this.actor = actorName(options.actor);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BD_TIMEOUT_MS;
    this.runner = options.runner ?? defaultBdRunner;
    this.requireExpectedVersion = options.requireExpectedVersion ?? false;
    this.authorityFingerprint = options.authorityFingerprint;
    if (!options.runner) {
      if (this.authorityFingerprint) assertBeadsAuthorityFingerprint(this.workspace, this.authorityFingerprint);
      else assertBeadsWorkspaceRoot(this.workspace);
    }
  }

  async assertWorkspaceRoot(expected = this.authorityFingerprint): Promise<BeadsAuthorityFingerprint> {
    const actual = expected
      ? assertBeadsAuthorityFingerprint(this.workspace, expected)
      : readBeadsAuthorityFingerprint(this.workspace);
    const result = await this.command<{ path?: string }>(["where"]);
    if (!result || typeof result.path !== "string") {
      throw new BeadsError("Beads where returned no authority root path.", "malformed", "bd where");
    }
    const expectedRoot = fs.realpathSync(path.join(this.workspace, ".beads"));
    let observed: string;
    try {
      observed = fs.realpathSync(result.path);
    } catch (error) {
      throw new BeadsError(
        `Beads reported an unreadable authority root ${result.path}: ${error instanceof Error ? error.message : String(error)}.`,
        "malformed",
        "bd where",
      );
    }
    if (observed !== expectedRoot) {
      throw new BeadsError(
        `Beads resolved workspace ${this.workspace} to ${result.path}, not its exact authority root ${path.join(this.workspace, ".beads")}; refusing ancestor or alternate-database binding.`,
        "scope",
        "bd where",
      );
    }
    return actual;
  }

  private async command<T>(args: string[]): Promise<T> {
    const fullArgs = ["--directory", this.workspace, "--json", ...args];
    const display = ["bd", ...fullArgs].join(" ");
    const startedAt = Date.now();
    const command = args[0] || "unknown";
    try {
      const result = parseJson<T>(await this.runner.run(fullArgs, { cwd: this.workspace, timeoutMs: this.timeoutMs }), display);
      recordBdCall(command, Date.now() - startedAt, "ok");
      return result;
    } catch (error) {
      recordBdCall(command, Date.now() - startedAt, "error");
      throw error;
    }
  }

  private lockPath(taskId: string): string {
    fs.mkdirSync(teamDir(this.teamName), { recursive: true });
    return path.join(teamDir(this.teamName), `.beads-task-${sanitizeName(taskId)}`);
  }

  private verifyScope(raw: RawBead): void {
    const labels = raw.labels || [];
    if (!labels.includes(beadsLabel(this.teamName)) || metadataValue(raw, "pi_teams_team") !== this.teamName) {
      throw new BeadsError(
        `Task ${raw.id} is not scoped to PiTeams team ${this.teamName}; refusing to mutate it.`,
        "scope",
        `bd show ${raw.id}`,
      );
    }
  }

  /** Beads 1.1 reports mixed missing IDs on stderr but exits successfully. */
  private isNativeShowMissing(error: unknown): boolean {
    return error instanceof BeadsError
      && error.kind === "command"
      && /(?:error fetching .+: no issue found matching|no issues found matching the provided ids)/i.test(error.message);
  }

  /**
   * Keep canonical show fallback below the measured contention tail.
   *
   * The native implementation still loops per ID. Four preserves bounded
   * exact hydration while avoiding the 13/16-ID deadline failures observed in
   * live DAG creation and sync.
   */
  private static readonly MAX_SHOW_IDS = 4;

  /**
   * Hydrate exact IDs in bounded native shows. Beads returns found IDs and omits
   * mixed missing IDs; all-missing IDs return the same documented error form.
   */
  private async showManyRawAllowMissing(taskIds: readonly string[]): Promise<Array<RawBead | undefined>> {
    const safeIds = [...new Set(taskIds.map((taskId) => sanitizeName(taskId)))];
    if (safeIds.length === 0) return [];

    const hydrated: Array<RawBead | undefined> = [];
    for (let start = 0; start < safeIds.length; start += BeadsTaskStore.MAX_SHOW_IDS) {
      const batchIds = safeIds.slice(start, start + BeadsTaskStore.MAX_SHOW_IDS);
      let result: RawBead[];
      try {
        result = await this.command<RawBead[]>(["show", ...batchIds, "--include-dependents"]);
      } catch (error) {
        if (this.isNativeShowMissing(error)) {
          hydrated.push(...batchIds.map(() => undefined));
          continue;
        }
        throw error;
      }
      if (!Array.isArray(result)) {
        throw new BeadsError("Beads show returned a non-array JSON value.", "malformed", `bd show ${batchIds.join(" ")}`);
      }
      const requested = new Set(batchIds);
      const byId = new Map<string, RawBead>();
      for (const raw of result) {
        if (!raw?.id) continue;
        if (!requested.has(raw.id)) {
          throw new BeadsError(`Beads show returned unrequested task ${raw.id}.`, "scope", `bd show ${batchIds.join(" ")}`);
        }
        this.verifyScope(raw);
        if (byId.has(raw.id)) {
          throw new BeadsError(`Beads show returned duplicate task ${raw.id}.`, "conflict", `bd show ${batchIds.join(" ")}`);
        }
        byId.set(raw.id, raw);
      }
      hydrated.push(...batchIds.map((taskId) => byId.get(taskId)));
    }
    return hydrated;
  }

  private async showManyRaw(taskIds: readonly string[]): Promise<RawBead[]> {
    const safeIds = [...new Set(taskIds.map((taskId) => sanitizeName(taskId)))];
    const raws = await this.showManyRawAllowMissing(safeIds);
    return raws.map((raw, index) => {
      if (!raw) throw new BeadsError(`Beads task ${safeIds[index]} was not found.`, "command", `bd show ${safeIds[index]}`);
      return raw;
    });
  }

  private async showRaw(taskId: string): Promise<RawBead> {
    return (await this.showManyRaw([taskId]))[0];
  }

  /** Native `bd list` filters keep candidate discovery in the authority. */
  private async listRaw(options: { ids?: readonly string[]; metadataField?: { key: string; value: string }; assignee?: string; statuses?: readonly TaskStatus[]; ready?: boolean } = {}): Promise<RawBead[]> {
    const args = [
      "list", "--label", beadsLabel(this.teamName),
      ...(options.ready ? [] : ["--all"]),
      "--no-pager", "--limit", "0",
    ];
    if (options.ids?.length) args.push("--id", options.ids.join(","));
    if (options.metadataField) args.push("--metadata-field", `${options.metadataField.key}=${options.metadataField.value}`);
    if (options.assignee) args.push("--assignee", sanitizeName(options.assignee));
    if (options.statuses?.length) args.push("--status", options.statuses.join(","));
    if (options.ready) args.push("--ready");
    const result = await this.command<RawBead[]>(args);
    if (!Array.isArray(result)) throw new BeadsError("Beads list returned a non-array JSON value.", "malformed", "bd list");
    for (const raw of result) this.verifyScope(raw);
    return result;
  }

  /**
   * Read only dispatch candidates and active Worker slots.
   *
   * Native ready/status filters avoid a whole-Team canonical hydration. At
   * most one ready Task per free Worker then crosses the exact show boundary.
   */
  async readReadyDispatchSnapshot(workerName?: string): Promise<BeadsReadyDispatchSnapshot> {
    const assignee = workerName ? sanitizeName(workerName) : undefined;
    const inProgress = await this.listRaw({ ...(assignee ? { assignee } : {}), statuses: ["in_progress"] });
    const occupiedWorkers = [...new Set(inProgress.flatMap((raw) => raw.assignee ? [raw.assignee] : []))].sort();
    const occupied = new Set(occupiedWorkers);
    const ready = (await this.listRaw({ ...(assignee ? { assignee } : {}), ready: true }))
      .filter((raw) => raw.assignee && !occupied.has(raw.assignee))
      .sort((left, right) => left.id.localeCompare(right.id));
    const selected: RawBead[] = [];
    const selectedWorkers = new Set<string>();
    for (const raw of ready) {
      if (!raw.assignee || selectedWorkers.has(raw.assignee)) continue;
      selected.push(raw);
      selectedWorkers.add(raw.assignee);
    }
    const exact = await this.showManyRawAllowMissing(selected.map((raw) => raw.id));
    const readyTasks = exact.map((raw, index) => {
      if (!raw) throw new BeadsError(`Ready Task ${selected[index].id} disappeared before exact hydration.`, "command", `bd show ${selected[index].id}`);
      return this.taskAuthorityRecordEnvelope(raw);
    });
    return { readyTasks, occupiedWorkers };
  }

  /** Exact Worker stop guard; it does not hydrate the full Team Task set. */
  async listNonterminalTaskIdsAssignedTo(workerName: string): Promise<string[]> {
    return (await this.listRaw({ assignee: workerName, statuses: ["open", "in_progress", "blocked"] }))
      .filter((raw) => metadataValue(raw, "pi_teams_deleted") !== "true")
      .map((raw) => raw.id)
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * `bd list --id` is the fast exact-ID path. Its compact record is usable
   * only when it proves the relation inputs used by the authority version.
   */
  private hasExactListFidelity(raw: RawBead): boolean {
    const exactCount = (count: number | undefined, values: unknown[] | undefined): boolean =>
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0
        ? count === (values?.length ?? 0)
        : Array.isArray(values);
    // authorityVersion hashes each of these fields. A compact list result
    // cannot stand in for canonical show unless it supplies every input.
    const completeVersionFields = typeof raw.id === "string"
      && typeof raw.title === "string"
      && ["open", "in_progress", "blocked", "deferred", "closed"].includes(raw.status)
      && typeof raw.description === "string"
      && typeof raw.acceptance_criteria === "string"
      && typeof raw.design === "string"
      && typeof raw.notes === "string"
      && typeof raw.parent === "string"
      && typeof raw.assignee === "string"
      && typeof raw.updated_at === "string"
      && Number.isFinite(Date.parse(raw.updated_at))
      && Array.isArray(raw.labels) && raw.labels.every((label) => typeof label === "string")
      && !!raw.metadata && !Array.isArray(raw.metadata)
      && Array.isArray(raw.dependencies)
      && Array.isArray(raw.dependents);
    return completeVersionFields
      && exactCount(raw.dependency_count, raw.dependencies)
      && exactCount(raw.dependent_count, raw.dependents)
      && typeof raw.comment_count === "number" && Number.isSafeInteger(raw.comment_count) && raw.comment_count >= 0;
  }

  private async listExactRawAllowMissing(taskIds: readonly string[]): Promise<Array<RawBead | undefined> | undefined> {
    const safeIds = [...new Set(taskIds.map((taskId) => sanitizeName(taskId)))];
    if (safeIds.length === 0) return [];
    try {
      const result = await this.listRaw({ ids: safeIds });
      const requested = new Set(safeIds);
      const byId = new Map<string, RawBead>();
      for (const raw of result) {
        if (!raw?.id || !requested.has(raw.id)) {
          throw new BeadsError(`Beads list returned unrequested task ${raw?.id || "without an ID"}.`, "scope", "bd list --id");
        }
        if (byId.has(raw.id)) {
          throw new BeadsError(`Beads list returned duplicate task ${raw.id}.`, "conflict", "bd list --id");
        }
        if (!this.hasExactListFidelity(raw)) return undefined;
        byId.set(raw.id, raw);
      }
      return safeIds.map((taskId) => byId.get(taskId));
    } catch {
      // The documented exact list filter is an optimization. A list failure
      // never changes the canonical show-based authority semantics.
      return undefined;
    }
  }

  async findByLegacyId(legacyId: string): Promise<TaskAuthorityRecord | undefined> {
    const matches = (await this.listRaw()).filter(raw => metadataValue(raw, "pi_teams_legacy_id") === legacyId);
    if (matches.length > 1) {
      throw new BeadsError(
        `Duplicate Beads tasks map to legacy Task ${legacyId}; refusing to choose one.`,
        "conflict",
        `bd list legacy:${legacyId}`,
      );
    }
    return matches[0] ? mapTask(matches[0]) : undefined;
  }

  async create(input: CreateTaskInput, options: TaskWriteOptions = {}): Promise<TaskAuthorityRecord> {
    return (await this.createWithResult(input, options)).task;
  }

  /** Read graph-operation metadata without validating now-stale expansion refs. */
  async readGraphOperationReceipt(operationId: string, expectedKeys: readonly string[]): Promise<BeadsGraphOperationReceipt | undefined> {
    const existing = (await this.listRaw()).filter((raw) => metadataValue(raw, "pi_teams_graph_operation") === operationId);
    if (existing.length === 0) return undefined;
    const fingerprints = new Set(existing.map((raw) => metadataValue(raw, "pi_teams_graph_fingerprint")));
    const byKey = new Map(existing.map((raw) => [metadataValue(raw, "pi_teams_graph_key"), raw]));
    if (fingerprints.size !== 1 || fingerprints.has(undefined) || byKey.size !== expectedKeys.length || expectedKeys.some((key) => !byKey.has(key))) {
      throw new BeadsError("The graph operation receipt is incomplete or ambiguous; refusing duplicate recovery.", "conflict", `bd create --graph ${operationId}`);
    }
    return {
      fingerprint: [...fingerprints][0]!,
      tasksByKey: Object.fromEntries(expectedKeys.map((key) => [key, this.taskAuthorityRecordEnvelope(byKey.get(key)!)])),
    };
  }

  /**
   * Commit one Task DAG through Beads' atomic graph-plan command.
   * Pi Team Bright metadata supplies request replay because native graph
   * creation otherwise duplicates nodes on an exact retry.
   */
  async createGraphWithResult(input: BeadsGraphCreateInput, options: TaskWriteOptions = {}): Promise<BeadsGraphCreateResult> {
    if (!input.operationId.trim()) throw new Error("Graph operation ID must not be empty");
    if (input.nodes.length === 0) throw new Error("A Task graph must create at least one Task");
    const nodeKeys = new Set<string>();
    for (const node of input.nodes) {
      if (!node.key.trim() || nodeKeys.has(node.key)) throw new Error(`Task graph key must be unique and nonempty: ${node.key}`);
      nodeKeys.add(node.key);
      if (!node.title.trim()) throw new Error(`Task ${node.key} title must not be empty`);
      if (node.assignee && !node.acceptanceCriteria?.trim()) throw new Error(`Assigned Task ${node.key} requires nonempty acceptance criteria`);
      if (node.internalMetadata && TASK_METADATA_KEY in node.internalMetadata) assertTaskMetadataContext(node.internalMetadata[TASK_METADATA_KEY]);
    }
    const operationHash = crypto.createHash("sha256").update(input.operationId).digest("hex");
    fs.mkdirSync(teamDir(this.teamName), { recursive: true });
    return withLock(path.join(teamDir(this.teamName), `.beads-graph-create-${operationHash}`), async () => {
      const receipt = await this.readGraphOperationReceipt(input.operationId, input.nodes.map((node) => node.key));
      if (receipt) {
        if (receipt.fingerprint !== input.fingerprint) {
          throw new BeadsError("The graph operation ID was already used with different initial semantics.", "conflict", `bd create --graph ${input.operationId}`);
        }
        return { replayed: true, tasksByKey: receipt.tasksByKey };
      }

      const metadataFor = (node: BeadsGraphCreateInput["nodes"][number]) => ({
        ...(node.internalMetadata || {}),
        pi_teams_team: this.teamName,
        pi_teams_source: "pi-teams",
        pi_teams_schema: PI_TEAMS_SCHEMA,
        pi_teams_graph_operation: input.operationId,
        pi_teams_graph_fingerprint: input.fingerprint,
        pi_teams_graph_key: node.key,
      });
      const plan = {
        nodes: input.nodes.map((node) => ({
          key: node.key,
          title: node.title,
          description: node.description,
          ...(node.assignee ? { assignee: node.assignee } : {}),
          labels: [beadsLabel(this.teamName)],
          metadata: Object.fromEntries(Object.entries(metadataFor(node)).map(([key, value]) => [
            key,
            typeof value === "string" ? value : JSON.stringify(value),
          ])),
        })),
        edges: input.edges.map((edge) => ({
          ...( "key" in edge.from ? { from_key: edge.from.key } : { from_id: edge.from.id }),
          ...( "key" in edge.to ? { to_key: edge.to.key } : { to_id: edge.to.id }),
          type: "blocks",
        })),
      };
      const planPath = path.join(this.workspace, `.pi-teams-graph-${operationHash}-${process.pid}.json`);
      fs.writeFileSync(planPath, JSON.stringify(plan), { encoding: "utf8", mode: 0o600, flag: "wx" });
      let result: { ids?: Record<string, string>; schema_version?: number };
      try {
        result = await this.command(["create", "--graph", planPath, "--actor", actorName(options.actor || this.actor)]);
      } finally {
        try { fs.unlinkSync(planPath); } catch { /* best-effort removal of a non-authority intermediate */ }
      }
      if (!result || result.schema_version !== 1 || !result.ids || input.nodes.some((node) => typeof result.ids![node.key] !== "string")) {
        throw new BeadsError("Beads graph create returned no complete schema-1 key mapping.", "malformed", "bd create --graph");
      }
      const raws = await this.showManyRaw(input.nodes.map((node) => result.ids![node.key]));
      return {
        replayed: false,
        tasksByKey: Object.fromEntries(input.nodes.map((node, index) => [node.key, this.taskAuthorityRecordEnvelope(raws[index])])),
      };
    }, options.retries);
  }

  async createWithResult(input: CreateTaskInput, options: TaskWriteOptions = {}): Promise<TaskCreateResult> {
    if (input.internalMetadata && TASK_METADATA_KEY in input.internalMetadata) {
      assertTaskMetadataContext(input.internalMetadata[TASK_METADATA_KEY]);
    }
    if (!input.title || !input.title.trim()) throw new Error("Task title must not be empty");
    if (input.assignee && !input.acceptanceCriteria?.trim() && !input.internalMetadata) {
      throw new Error("Assigned Tasks require nonempty acceptance criteria");
    }
    const idempotencyKey = input.idempotencyKey || options.idempotencyKey;
    const create = async (): Promise<TaskCreateResult> => {
      if (idempotencyKey) {
        const existing = await this.listRaw({ metadataField: { key: "pi_teams_idempotency_key", value: idempotencyKey } });
        if (existing.length > 1) throw new BeadsError(`Duplicate Beads tasks share idempotency key ${idempotencyKey}; refusing to choose a mapping.`, "conflict", `bd list ${idempotencyKey}`);
        if (existing[0]) return { task: mapTask(existing[0]), taskEnvelope: this.taskAuthorityRecordEnvelope(existing[0]), replayed: true };
      }
      const metadata = {
        ...(input.internalMetadata || {}),
        pi_teams_team: this.teamName,
        pi_teams_source: "pi-teams",
        pi_teams_schema: PI_TEAMS_SCHEMA,
        ...(idempotencyKey ? { pi_teams_idempotency_key: idempotencyKey } : {}),
      };
      const args = [
        "create",
        "--title", input.title,
        "--description", input.description,
        "--labels", beadsLabel(this.teamName),
        "--metadata", JSON.stringify(metadata),
        "--actor", actorName(options.actor || this.actor),
      ];
      if (input.acceptanceCriteria) args.push("--acceptance", input.acceptanceCriteria);
      if (input.design) args.push("--design", input.design);
      if (input.assignee) args.push("--assignee", input.assignee);
      const raw = await this.command<RawBead | RawBead[]>(args);
      const created = Array.isArray(raw) ? raw[0] : raw;
      if (!created?.id) throw new BeadsError("Beads create returned no task ID.", "malformed", "bd create");
      this.verifyScope(created);
      const committed = await this.showRaw(created.id);
      return { task: mapTask(committed), taskEnvelope: this.taskAuthorityRecordEnvelope(committed), replayed: false };
    };
    if (!idempotencyKey) return create();
    fs.mkdirSync(teamDir(this.teamName), { recursive: true });
    const keyHash = crypto.createHash("sha256").update(idempotencyKey).digest("hex");
    return withLock(path.join(teamDir(this.teamName), `.beads-create-${keyHash}`), create, options.retries);
  }

  private assertExpectedVersion(before: RawBead, options: TaskWriteOptions, operation: string): void {
    if (this.requireExpectedVersion && !options.expectedVersion) {
      throw new BeadsError(`expected_version is required for Beads ${operation} after cutover. Read the task again and retry.`, "conflict", `bd ${operation}`);
    }
    if (options.expectedVersion && authorityVersion(before) !== options.expectedVersion) {
      throw new BeadsError(
        `Task ${before.id} changed since version ${options.expectedVersion}; refusing ${operation}. Beads 1.1.0 has no true conditional write, so this token is a best-effort preflight and external writers can still race after the check. Re-read and retry.`,
        "conflict",
        `bd ${operation} ${before.id}`,
      );
    }
  }

  private assertNotDeleted(before: RawBead, operation: string): void {
    if (metadataValue(before, "pi_teams_deleted") !== "true") return;
    throw new BeadsError(
      `Task ${before.id} is deleted and immutable; refusing ${operation}. Create a new Task instead of mutating soft-deleted history.`,
      "conflict",
      `bd ${operation} ${before.id}`,
    );
  }

  private assertNotImplicitCompletedReopen(before: RawBead, operation: string): void {
    if (before.status !== "closed") return;
    throw new BeadsError(
      `Task ${before.id} is completed; ${operation} cannot reopen it implicitly. Use task_update with an explicit nonterminal status first, then retry.`,
      "conflict",
      `bd ${operation} ${before.id}`,
    );
  }

  async read(taskId: string): Promise<TaskAuthorityRecord> {
    return mapTask(await this.showRaw(taskId));
  }

  private taskAuthorityRecordEnvelope(raw: RawBead): TaskAuthorityRecordEnvelope {
    return {
      task: mapTask(raw),
      ...(raw.metadata && TASK_METADATA_KEY in raw.metadata
        ? { taskMetadata: raw.metadata[TASK_METADATA_KEY] }
        : {}),
      ...(metadataValue(raw, OWNER_TRANSITION_OPERATION_METADATA)
        ? { ownerTransitionOperationId: metadataValue(raw, OWNER_TRANSITION_OPERATION_METADATA) }
        : {}),
    };
  }

  /** Read the canonical Task payload without projecting compatibility fields. */
  async readTaskAuthorityRecordEnvelope(taskId: string): Promise<TaskAuthorityRecordEnvelope> {
    return this.taskAuthorityRecordEnvelope(await this.showRaw(taskId));
  }

  /**
   * Hydrate exact Task payloads with one Beads authority query.
   * Each returned position matches the unique requested-ID order; a missing
   * authority record is undefined rather than a second native show.
   */
  async readTaskAuthorityRecordEnvelopes(taskIds: readonly string[]): Promise<Array<TaskAuthorityRecordEnvelope | undefined>> {
    const exact = await this.listExactRawAllowMissing(taskIds);
    const raws = exact ?? await this.showManyRawAllowMissing(taskIds);
    return raws.map((raw) => raw ? this.taskAuthorityRecordEnvelope(raw) : undefined);
  }

  /** Hydrate several exact Task revisions with one Beads authority query. */
  async readMany(taskIds: readonly string[]): Promise<TaskAuthorityRecord[]> {
    return (await this.showManyRaw(taskIds)).map(mapTask);
  }

  /** Read authority evidence used only to settle the delivery outbox. */
  async readOwnerTransitionEvidence(taskId: string): Promise<{
    task: TaskAuthorityRecord;
    operationId?: string;
    taskProjection?: { goal?: string; current_context?: string };
  }> {
    const raw = await this.showRaw(taskId);
    let taskMetadata: unknown = raw.metadata?.[TASK_METADATA_KEY];
    if (typeof taskMetadata === "string") {
      try {
        taskMetadata = JSON.parse(taskMetadata);
      } catch {
        taskMetadata = undefined;
      }
    }
    const taskProjection = taskMetadata && typeof taskMetadata === "object"
      ? {
        ...(typeof (taskMetadata as Record<string, unknown>).goal === "string"
          ? { goal: (taskMetadata as Record<string, unknown>).goal as string }
          : {}),
        ...(typeof (taskMetadata as Record<string, unknown>).current_context === "string"
          ? { current_context: (taskMetadata as Record<string, unknown>).current_context as string }
          : {}),
      }
      : undefined;
    return {
      task: mapTask(raw),
      operationId: metadataValue(raw, OWNER_TRANSITION_OPERATION_METADATA),
      ...(taskProjection ? { taskProjection } : {}),
    };
  }

  async list(): Promise<TaskAuthorityRecord[]> {
    const raws = (await this.listRaw()).filter(raw => metadataValue(raw, "pi_teams_deleted") !== "true");
    return mapWithReverseDependencies(raws)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async updateWithResultLocked(
    safeId: string,
    updates: Partial<TaskAuthorityRecord>,
    options: TaskWriteOptions,
    beforeRaw: RawBead,
  ): Promise<TaskMutationResult> {
    const args: string[] = ["update", safeId, "--actor", actorName(options.actor || this.actor)];
    if (updates.title !== undefined) args.push("--title", updates.title);
    if (updates.description !== undefined) args.push("--description", updates.description);
    if (updates.acceptanceCriteria !== undefined) args.push("--acceptance", updates.acceptanceCriteria);
    if (updates.design !== undefined) args.push("--design", updates.design);
    if (updates.assignee !== undefined) args.push("--assignee", updates.assignee || "");
    if (options.appendNote !== undefined) {
      if (!options.appendNote.trim()) throw new Error("Task note must not be empty");
      args.push("--append-notes", options.appendNote);
    }
    if (options.internalOwnerTransition) {
      args.push("--set-metadata", `${OWNER_TRANSITION_OPERATION_METADATA}=${options.internalOwnerTransition.operationId}`);
    }
    if (options.taskMetadata) {
      args.push("--set-metadata", `${TASK_METADATA_KEY}=${JSON.stringify(options.taskMetadata)}`);
    }
    if (updates.status === "open") args.push("--status", "open");
    if (updates.status === "in_progress") args.push("--status", "in_progress");
    if (updates.status === "blocked" || updates.status === "closed") {
      if (beforeRaw.status !== updates.status && !options.appendNote?.trim()) {
        throw new Error(`Transitioning a Task to ${updates.status} requires a nonempty evidence note in the same update`);
      }
      args.push("--status", updates.status);
    }
    if (args.length > 4) {
      await this.command<RawBead | RawBead[]>(args);
    }
    // Beads command responses can expose a pre-commit updated_at. Only a
    // fresh show supplies a version token safe to advertise to callers.
    const after = await this.showRaw(safeId);
    const mapped = mapTask(after);
    if (updates.status === "closed" && beforeRaw.status !== "closed") await runHook(this.teamName, "task_closed", mapped);
    return {
      before: mapTask(beforeRaw),
      after: mapped,
      beforeEnvelope: this.taskAuthorityRecordEnvelope(beforeRaw),
      afterEnvelope: this.taskAuthorityRecordEnvelope(after),
      appliedOperations: [
        ...Object.keys(updates).map((field) => `set:${field}`),
        ...(options.appendNote !== undefined ? ["append:note"] : []),
        ...(options.taskMetadata !== undefined ? ["set:taskMetadata"] : []),
      ],
    };
  }

  async updateWithResult(taskId: string, updates: Partial<TaskAuthorityRecord>, options: TaskWriteOptions = {}): Promise<TaskMutationResult> {
    if (options.taskMetadata !== undefined) assertTaskMetadataContext(options.taskMetadata);
    const safeId = sanitizeName(taskId);
    return withLock(this.lockPath(safeId), async () => {
      const beforeRaw = await this.showRaw(safeId);
      this.assertNotDeleted(beforeRaw, "update");
      this.assertExpectedVersion(beforeRaw, options, "update");
      const prepared = (
        updates.assignee !== undefined
        && options.internalOwnerTransition
        && await options.internalOwnerTransition.prepare(
          this.taskAuthorityRecordEnvelope(beforeRaw),
          metadataValue(beforeRaw, OWNER_TRANSITION_OPERATION_METADATA),
        )
      );
      return this.updateWithResultLocked(
        safeId,
        updates,
        prepared ? options : { ...options, internalOwnerTransition: undefined },
        beforeRaw,
      );
    }, options.retries);
  }

  async update(taskId: string, updates: Partial<TaskAuthorityRecord>, options: TaskWriteOptions = {}): Promise<TaskAuthorityRecord> {
    return (await this.updateWithResult(taskId, updates, options)).after;
  }

  async claimWithResult(taskId: string, actor?: string, options: TaskWriteOptions = {}): Promise<TaskMutationResult> {
    if (options.taskMetadata !== undefined) assertTaskMetadataContext(options.taskMetadata);
    const safeId = sanitizeName(taskId);
    return withLock(this.lockPath(safeId), async () => {
      const beforeRaw = await this.showRaw(safeId);
      this.assertNotDeleted(beforeRaw, "claim");
      this.assertNotImplicitCompletedReopen(beforeRaw, "claim");
      const activeBlockers = mapTask(beforeRaw).activeBlockerIds ?? [];
      if (activeBlockers.length > 0) {
        throw new BeadsError(`Task ${taskId} has active blockers: ${activeBlockers.join(", ")}.`, "conflict", `bd update ${taskId} --claim`);
      }
      if (options.expectedVersion && authorityVersion(beforeRaw) !== options.expectedVersion) {
        throw new BeadsError(`Task ${taskId} changed before claim; re-read and retry.`, "conflict", `bd update ${taskId} --claim`);
      }
      const prepared = options.internalOwnerTransition
        ? await options.internalOwnerTransition.prepare(
          this.taskAuthorityRecordEnvelope(beforeRaw),
          metadataValue(beforeRaw, OWNER_TRANSITION_OPERATION_METADATA),
        )
        : false;
      const claimActor = actorName(actor || options.actor || this.actor);
      if (beforeRaw.assignee && beforeRaw.assignee !== claimActor) {
        throw new BeadsError(`Task ${taskId} is assigned to ${beforeRaw.assignee}, not ${claimActor}; refusing claim.`, "conflict", `bd update ${taskId} --claim`);
      }
      const args = beforeRaw.assignee === claimActor
        ? ["update", safeId, "--status", "in_progress", "--actor", claimActor]
        : ["update", safeId, "--claim", "--actor", claimActor];
      if (prepared && options.internalOwnerTransition) {
        args.push("--set-metadata", `${OWNER_TRANSITION_OPERATION_METADATA}=${options.internalOwnerTransition.operationId}`);
      }
      if (options.taskMetadata) {
        args.push("--set-metadata", `${TASK_METADATA_KEY}=${JSON.stringify(options.taskMetadata)}`);
      }
      const result = await this.command<RawBead | RawBead[]>(args);
      const after = Array.isArray(result) ? result[0] : result;
      const committed = await this.showRaw(after?.id || safeId);
      return {
        before: mapTask(beforeRaw),
        after: mapTask(committed),
        beforeEnvelope: this.taskAuthorityRecordEnvelope(beforeRaw),
        afterEnvelope: this.taskAuthorityRecordEnvelope(committed),
        appliedOperations: ["claim"],
      };
    }, options.retries);
  }

  async claim(taskId: string, actor?: string, options: TaskWriteOptions = {}): Promise<TaskAuthorityRecord> {
    return (await this.claimWithResult(taskId, actor, options)).after;
  }

  async mutateLinkWithResult(taskId: string, link: BeadsTaskLink, options: TaskWriteOptions = {}): Promise<TaskMutationResult> {
    const safeTaskId = sanitizeName(taskId);
    const safeTargetId = sanitizeName(link.targetId);
    if (safeTaskId === safeTargetId) throw new Error("A task cannot link to itself");
    let before!: TaskAuthorityRecord;
    let beforeEnvelope!: TaskAuthorityRecordEnvelope;
    let changed = false;
    await withLock(this.lockPath(safeTaskId), async () => {
      const taskRaw = await this.showRaw(safeTaskId);
      beforeEnvelope = this.taskAuthorityRecordEnvelope(taskRaw);
      this.assertExpectedVersion(taskRaw, options, "link");
      await this.showRaw(safeTargetId);
      const task = mapTask(taskRaw);
      before = task;
      const existingParent = task.relations.find((relation) => relation.relation === "parent");
      if (link.relation === "parent") {
        if (link.action === "add" && existingParent && existingParent.targetId !== safeTargetId) {
          throw new BeadsError(
            `Task ${safeTaskId} already has parent ${existingParent.targetId}; remove that parent explicitly before adding ${safeTargetId}.`,
            "conflict",
            `bd update ${safeTaskId} --parent ${safeTargetId}`,
          );
        }
        if (link.action === "remove" && existingParent && existingParent.targetId !== safeTargetId) {
          throw new BeadsError(
            `Task ${safeTaskId} has parent ${existingParent.targetId}, not ${safeTargetId}; refusing to remove a different parent.`,
            "conflict",
            `bd update ${safeTaskId} --parent`,
          );
        }
      }
      const exists = task.relations.some((relation) => relation.relation === link.relation && relation.targetId === safeTargetId);
      if ((link.action === "add") === exists) return;
      const actor = actorName(options.actor || this.actor);
      if (link.relation === "blocked_by") {
        await this.command(link.action === "add"
          ? ["dep", "add", safeTaskId, safeTargetId, "--type", "blocks", "--actor", actor]
          : ["dep", "remove", safeTaskId, safeTargetId, "--actor", actor]);
      } else if (link.relation === "related") {
        await this.command(["dep", link.action === "add" ? "relate" : "unrelate", safeTaskId, safeTargetId, "--actor", actor]);
      } else {
        await this.command(["update", safeTaskId, "--parent", link.action === "add" ? safeTargetId : "", "--actor", actor]);
      }
      changed = true;
    }, options.retries);
    const afterEnvelope = await this.readTaskAuthorityRecordEnvelope(safeTaskId);
    const after = afterEnvelope.task;
    return {
      before,
      after,
      beforeEnvelope,
      afterEnvelope,
      appliedOperations: changed ? [`${link.action}:${link.relation}:${safeTargetId}`] : [],
    };
  }

  async mutateLink(taskId: string, link: BeadsTaskLink, options: TaskWriteOptions = {}): Promise<TaskAuthorityRecord> {
    return (await this.mutateLinkWithResult(taskId, link, options)).after;
  }

}
