import { execFile } from "node:child_process";
import { Type } from "typebox";
import { Check } from "typebox/value";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { BeadsAuthorityFingerprint, TaskFile, TaskRelation, TaskRelationType } from "./models";
import { withLock } from "./lock";
import { teamDir, sanitizeName } from "./paths";
import { runHook } from "./hooks";
import crypto from "node:crypto";
import { recordBdCall } from "./trace";

const execFileAsync = promisify(execFile);

export const DEFAULT_BD_TIMEOUT_MS = 10_000;
export const DEFAULT_BD_INIT_TIMEOUT_MS = 30_000;
export const PI_TEAMS_SCHEMA = "1";
export const CANDIDATE_TASK_METADATA_KEY = "pi_teams_candidate_task";
export const CANDIDATE_TASK_METADATA_SCHEMA = "pi-teams-candidate-task/1" as const;
/** Standard TypeBox length limit for model-facing candidate Task context. */
export const CANDIDATE_TASK_CURRENT_CONTEXT_MAX_LENGTH = 2_000;
export const CandidateTaskCurrentContextSchema = Type.String({
  minLength: 1,
  maxLength: CANDIDATE_TASK_CURRENT_CONTEXT_MAX_LENGTH,
});

/** Use the exported schema for every runtime candidate-context validation. */
export function isCandidateTaskCurrentContext(value: unknown): value is string {
  return Check(CandidateTaskCurrentContextSchema, value);
}

/** Reject invalid canonical context before a Beads command can mutate it. */
export function assertCandidateTaskMetadataContext(value: unknown): asserts value is CandidateTaskMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isCandidateTaskCurrentContext((value as Record<string, unknown>).current_context)) {
    throw new Error(`Candidate Task current_context must contain 1 to ${CANDIDATE_TASK_CURRENT_CONTEXT_MAX_LENGTH.toLocaleString("en-US")} TypeBox string-length units.`);
  }
}

export interface CandidateTaskOperationRecord {
  operation_id: string;
  fingerprint: string;
  journal_entries: Array<{ id: string; at: string; actor: string; kind: "progress" | "decision" | "blocker" | "result" | "note"; text: string }>;
}

export interface CandidateTaskMetadata {
  schema: typeof CANDIDATE_TASK_METADATA_SCHEMA;
  goal: string;
  current_context: string;
  last_operation?: CandidateTaskOperationRecord;
}

export interface CandidateTaskAuthorityRecord {
  task: TaskFile;
  candidateMetadata?: unknown;
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
 * package's `node_modules/.bin`; invoking the package bin avoids silently
 * binding Task authority to an unrelated global `bd` version. The wrapper is
 * present in every npm install, but its platform-native sibling is acquired by
 * @beads/bd postinstall (or deliberately materialized by CI).
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
    const executable = path.resolve(packageRoot, bin);
    if (!fs.statSync(executable).isFile()) throw new OwnedBdBinaryError(
      "BEADS_OWNED_BINARY_MISSING",
      `owned @beads/bd launcher is missing at ${executable}`,
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
    return executable;
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

class ExecBdRunner implements BdRunner {
  async run(args: string[], options: { cwd: string; timeoutMs: number }): Promise<BdCommandResult> {
    try {
      const result = await execFileAsync(resolveBdExecutable(), args, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
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
  candidateTaskMetadata?: CandidateTaskMetadata;
  retries?: number;
  /** Internal precommit hook; never part of the agent-facing Task contract. */
  internalOwnerTransition?: {
    operationId: string;
    prepare(before: TaskFile, previousOperationId?: string): Promise<boolean>;
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
  before: TaskFile;
  after: TaskFile;
  appliedOperations: string[];
}

/** Result of a create, including whether an idempotency replay supplied the Task. */
export interface TaskCreateResult {
  task: TaskFile;
  replayed: boolean;
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

function mapStatus(raw: RawBead): TaskFile["status"] {
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

function mapTask(raw: RawBead): TaskFile {
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
    version: authorityVersion(raw),
    provenance: { authority: "beads", teamName: metadataValue(raw, "pi_teams_team") || "unknown" },
  };
}

function mapWithReverseDependencies(raws: RawBead[]): TaskFile[] {
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

  private async showManyRaw(taskIds: readonly string[]): Promise<RawBead[]> {
    const safeIds = [...new Set(taskIds.map((taskId) => sanitizeName(taskId)))];
    if (safeIds.length === 0) return [];
    const result = await this.command<RawBead[]>([
      "show", ...safeIds, "--include-dependents",
    ]);
    if (!Array.isArray(result)) {
      throw new BeadsError("Beads show returned a non-array JSON value.", "malformed", `bd show ${safeIds.join(" ")}`);
    }
    const byId = new Map<string, RawBead>();
    for (const raw of result) {
      if (!raw?.id) continue;
      this.verifyScope(raw);
      if (byId.has(raw.id)) {
        throw new BeadsError(`Beads show returned duplicate task ${raw.id}.`, "conflict", `bd show ${safeIds.join(" ")}`);
      }
      byId.set(raw.id, raw);
    }
    return safeIds.map((taskId) => {
      const raw = byId.get(taskId);
      if (!raw) throw new BeadsError(`Beads task ${taskId} was not found.`, "command", `bd show ${taskId}`);
      return raw;
    });
  }

  private async showRaw(taskId: string): Promise<RawBead> {
    return (await this.showManyRaw([taskId]))[0];
  }

  private async listRaw(): Promise<RawBead[]> {
    const result = await this.command<RawBead[]>(["list", "--label", beadsLabel(this.teamName), "--all", "--no-pager", "--limit", "0"]);
    if (!Array.isArray(result)) throw new BeadsError("Beads list returned a non-array JSON value.", "malformed", "bd list");
    for (const raw of result) this.verifyScope(raw);
    return result;
  }

  async findByLegacyId(legacyId: string): Promise<TaskFile | undefined> {
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

  async create(input: CreateTaskInput, options: TaskWriteOptions = {}): Promise<TaskFile> {
    return (await this.createWithResult(input, options)).task;
  }

  async createWithResult(input: CreateTaskInput, options: TaskWriteOptions = {}): Promise<TaskCreateResult> {
    if (input.internalMetadata && CANDIDATE_TASK_METADATA_KEY in input.internalMetadata) {
      assertCandidateTaskMetadataContext(input.internalMetadata[CANDIDATE_TASK_METADATA_KEY]);
    }
    if (!input.title || !input.title.trim()) throw new Error("Task title must not be empty");
    if (input.assignee && !input.acceptanceCriteria?.trim() && !input.internalMetadata) {
      throw new Error("Assigned Tasks require nonempty acceptance criteria");
    }
    const idempotencyKey = input.idempotencyKey || options.idempotencyKey;
    const create = async (): Promise<TaskCreateResult> => {
      if (idempotencyKey) {
        const existing = (await this.listRaw()).filter(raw => metadataValue(raw, "pi_teams_idempotency_key") === idempotencyKey);
        if (existing.length > 1) throw new BeadsError(`Duplicate Beads tasks share idempotency key ${idempotencyKey}; refusing to choose a mapping.`, "conflict", `bd list ${idempotencyKey}`);
        if (existing[0]) return { task: mapTask(existing[0]), replayed: true };
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
      return { task: mapTask(await this.showRaw(created.id)), replayed: false };
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

  async read(taskId: string): Promise<TaskFile> {
    return mapTask(await this.showRaw(taskId));
  }

  private candidateTaskAuthorityRecord(raw: RawBead): CandidateTaskAuthorityRecord {
    return {
      task: mapTask(raw),
      ...(raw.metadata && CANDIDATE_TASK_METADATA_KEY in raw.metadata
        ? { candidateMetadata: raw.metadata[CANDIDATE_TASK_METADATA_KEY] }
        : {}),
    };
  }

  /** Read the canonical candidate payload without projecting compatibility fields. */
  async readCandidateTaskAuthorityRecord(taskId: string): Promise<CandidateTaskAuthorityRecord> {
    return this.candidateTaskAuthorityRecord(await this.showRaw(taskId));
  }

  /** Hydrate candidate payloads with one Beads authority query. */
  async readCandidateTaskAuthorityRecords(taskIds: readonly string[]): Promise<CandidateTaskAuthorityRecord[]> {
    return (await this.showManyRaw(taskIds)).map((raw) => this.candidateTaskAuthorityRecord(raw));
  }

  /** Hydrate several exact Task revisions with one Beads authority query. */
  async readMany(taskIds: readonly string[]): Promise<TaskFile[]> {
    return (await this.showManyRaw(taskIds)).map(mapTask);
  }

  /** Read authority evidence used only to settle the delivery outbox. */
  async readOwnerTransitionEvidence(taskId: string): Promise<{ task: TaskFile; operationId?: string }> {
    const raw = await this.showRaw(taskId);
    return {
      task: mapTask(raw),
      operationId: metadataValue(raw, OWNER_TRANSITION_OPERATION_METADATA),
    };
  }

  async list(): Promise<TaskFile[]> {
    const raws = (await this.listRaw()).filter(raw => metadataValue(raw, "pi_teams_deleted") !== "true");
    return mapWithReverseDependencies(raws)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async updateWithResultLocked(
    safeId: string,
    updates: Partial<TaskFile>,
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
    if (options.candidateTaskMetadata) {
      args.push("--set-metadata", `${CANDIDATE_TASK_METADATA_KEY}=${JSON.stringify(options.candidateTaskMetadata)}`);
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
      appliedOperations: [
        ...Object.keys(updates).map((field) => `set:${field}`),
        ...(options.appendNote !== undefined ? ["append:note"] : []),
        ...(options.candidateTaskMetadata !== undefined ? ["set:candidateTaskMetadata"] : []),
      ],
    };
  }

  async updateWithResult(taskId: string, updates: Partial<TaskFile>, options: TaskWriteOptions = {}): Promise<TaskMutationResult> {
    if (options.candidateTaskMetadata !== undefined) assertCandidateTaskMetadataContext(options.candidateTaskMetadata);
    const safeId = sanitizeName(taskId);
    return withLock(this.lockPath(safeId), async () => {
      const beforeRaw = await this.showRaw(safeId);
      this.assertNotDeleted(beforeRaw, "update");
      this.assertExpectedVersion(beforeRaw, options, "update");
      const prepared = (
        updates.assignee !== undefined
        && options.internalOwnerTransition
        && await options.internalOwnerTransition.prepare(
          mapTask(beforeRaw),
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

  async update(taskId: string, updates: Partial<TaskFile>, options: TaskWriteOptions = {}): Promise<TaskFile> {
    return (await this.updateWithResult(taskId, updates, options)).after;
  }

  async claimWithResult(taskId: string, actor?: string, options: TaskWriteOptions = {}): Promise<TaskMutationResult> {
    const safeId = sanitizeName(taskId);
    return withLock(this.lockPath(safeId), async () => {
      const beforeRaw = await this.showRaw(safeId);
      this.assertNotDeleted(beforeRaw, "claim");
      this.assertNotImplicitCompletedReopen(beforeRaw, "claim");
      if (options.expectedVersion && authorityVersion(beforeRaw) !== options.expectedVersion) {
        throw new BeadsError(`Task ${taskId} changed before claim; re-read and retry.`, "conflict", `bd update ${taskId} --claim`);
      }
      const prepared = options.internalOwnerTransition
        ? await options.internalOwnerTransition.prepare(
          mapTask(beforeRaw),
          metadataValue(beforeRaw, OWNER_TRANSITION_OPERATION_METADATA),
        )
        : false;
      const args = ["update", safeId, "--claim", "--actor", actorName(actor || options.actor || this.actor)];
      if (prepared && options.internalOwnerTransition) {
        args.push("--set-metadata", `${OWNER_TRANSITION_OPERATION_METADATA}=${options.internalOwnerTransition.operationId}`);
      }
      const result = await this.command<RawBead | RawBead[]>(args);
      const after = Array.isArray(result) ? result[0] : result;
      return {
        before: mapTask(beforeRaw),
        after: mapTask(await this.showRaw(after?.id || safeId)),
        appliedOperations: ["claim"],
      };
    }, options.retries);
  }

  async claim(taskId: string, actor?: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    return (await this.claimWithResult(taskId, actor, options)).after;
  }

  async mutateLinkWithResult(taskId: string, link: BeadsTaskLink, options: TaskWriteOptions = {}): Promise<TaskMutationResult> {
    const safeTaskId = sanitizeName(taskId);
    const safeTargetId = sanitizeName(link.targetId);
    if (safeTaskId === safeTargetId) throw new Error("A task cannot link to itself");
    let before!: TaskFile;
    let changed = false;
    await withLock(this.lockPath(safeTaskId), async () => {
      const taskRaw = await this.showRaw(safeTaskId);
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
    const after = await this.read(safeTaskId);
    return { before, after, appliedOperations: changed ? [`${link.action}:${link.relation}:${safeTargetId}`] : [] };
  }

  async mutateLink(taskId: string, link: BeadsTaskLink, options: TaskWriteOptions = {}): Promise<TaskFile> {
    return (await this.mutateLinkWithResult(taskId, link, options)).after;
  }

}
