import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { BeadsAuthorityFingerprint, TaskFile } from "./models";
import { withLock } from "./lock";
import { teamDir, sanitizeName } from "./paths";
import { runHook } from "./hooks";
import crypto from "node:crypto";
import { recordBdCall } from "./trace";

const execFileAsync = promisify(execFile);

export const DEFAULT_BD_TIMEOUT_MS = 10_000;
export const PI_TEAMS_SCHEMA = "1";
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

export function bdExecFailure(error: any): BdCommandResult {
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  const commandMissing = error?.code === "ENOENT";
  const stderr = typeof error?.stderr === "string" && error.stderr
    ? error.stderr
    : commandMissing
      ? "bd: command not found"
      : "";
  const timedOut = error?.killed || error?.code === "ETIMEDOUT";
  const exitCode = commandMissing ? 127 : typeof error?.code === "number" ? error.code : timedOut ? 124 : 1;
  return { stdout, stderr, exitCode };
}

class ExecBdRunner implements BdRunner {
  async run(args: string[], options: { cwd: string; timeoutMs: number }): Promise<BdCommandResult> {
    try {
      const result = await execFileAsync("bd", args, {
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
  status: "open" | "in_progress" | "blocked" | "deferred" | "closed";
  assignee?: string;
  owner?: string;
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
  retries?: number;
  /** Internal precommit hook; never part of the agent-facing Task contract. */
  internalOwnerTransition?: {
    operationId: string;
    prepare(before: TaskFile, previousOperationId?: string): Promise<boolean>;
  };
}

export interface CreateTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, any>;
  idempotencyKey?: string;
}

export interface BeadsDependency {
  taskId: string;
  blockerId: string;
}

export interface BeadsProgressEntry {
  kind: "progress" | "pending-problem";
  text: string;
  actor?: string;
}

export interface TaskMutationResult {
  before: TaskFile;
  after: TaskFile;
  appliedOperations: string[];
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

function jsonMetadata(raw: RawBead): Record<string, any> {
  const value = raw.metadata?.pi_teams_metadata;
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function dependencyId(dependency: NonNullable<RawBead["dependencies"]>[number]): string | undefined {
  return dependency.id || dependency.depends_on_id || dependency.issue_id;
}

function isBlockingDependency(dependency: NonNullable<RawBead["dependencies"]>[number]): boolean {
  return (dependency.dependency_type || dependency.type || "blocks") === "blocks";
}

function mapStatus(raw: RawBead): TaskFile["status"] {
  if (metadataValue(raw, "pi_teams_deleted") === "true") return "deleted";
  if (raw.status === "closed") return "completed";
  if (raw.status === "in_progress") return "in_progress";
  if (raw.status === "blocked") return "blocked";
  if (metadataValue(raw, "pi_teams_phase") === "planning") return "planning";
  return "pending";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableValue(nested)]));
}

function authorityVersion(raw: RawBead): string {
  // `bd list` exposes relation/comment counts while `bd show` additionally
  // hydrates the corresponding arrays. Hash only their shared projection so
  // one authority revision has one token regardless of the read path. The
  // counts plus updated_at still advance for append-only comments and links.
  const count = (explicit: number | undefined, hydrated: unknown[] | undefined): number => {
    if (typeof explicit === "number" && Number.isSafeInteger(explicit) && explicit >= 0) return explicit;
    return hydrated?.length || 0;
  };
  const canonical = {
    id: raw.id,
    title: raw.title,
    description: raw.description || "",
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
  };
  return `beads_${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function mapTask(raw: RawBead): TaskFile {
  const blockedBy = (raw.dependencies || [])
    .filter(isBlockingDependency)
    .map(dependencyId)
    .filter((id): id is string => !!id);
  const blocks = (raw.dependents || [])
    .filter(isBlockingDependency)
    .map(dependencyId)
    .filter((id): id is string => !!id);
  const metadata: Record<string, any> = {
    ...jsonMetadata(raw),
    ...(metadataValue(raw, "pi_teams_active_form") ? { activeForm: metadataValue(raw, "pi_teams_active_form") } : {}),
    ...(metadataValue(raw, "pi_teams_plan_feedback") ? { planFeedback: metadataValue(raw, "pi_teams_plan_feedback") } : {}),
    ...(metadataValue(raw, "pi_teams_progress") ? { progress: metadataValue(raw, "pi_teams_progress") } : {}),
    ...(metadataValue(raw, "pi_teams_pending_problem") ? { pendingProblem: metadataValue(raw, "pi_teams_pending_problem") } : {}),
  };
  const comments = raw.comments || [];
  const progressComments = comments.filter(comment => comment.text.startsWith("[pi-teams progress]"));
  const pendingComments = comments.filter(comment => comment.text.startsWith("[pi-teams pending-problem]"));
  if (progressComments.length > 0) metadata.progressEntries = progressComments.map(comment => ({
    text: comment.text.replace(/^\[pi-teams progress\]\s*/, ""),
    actor: comment.author,
    at: comment.created_at,
  }));
  if (pendingComments.length > 0) metadata.pendingProblemEntries = pendingComments.map(comment => ({
    text: comment.text.replace(/^\[pi-teams pending-problem\]\s*/, ""),
    actor: comment.author,
    at: comment.created_at,
  }));
  const plan = metadataValue(raw, "pi_teams_plan");
  return {
    id: raw.id,
    subject: raw.title,
    description: raw.description || "",
    activeForm: metadataValue(raw, "pi_teams_active_form") || undefined,
    status: mapStatus(raw),
    plan: plan || undefined,
    planFeedback: metadataValue(raw, "pi_teams_plan_feedback") || undefined,
    blocks,
    blockedBy,
    owner: raw.assignee,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    version: authorityVersion(raw),
  };
}

function mapWithReverseDependencies(raws: RawBead[]): TaskFile[] {
  const tasks = raws.map(mapTask);
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const raw of raws) {
    const task = byId.get(raw.id);
    if (!task) continue;
    for (const dependency of raw.dependencies || []) {
      if (!isBlockingDependency(dependency)) continue;
      const blockerId = dependencyId(dependency);
      if (!blockerId) continue;
      const blocker = byId.get(blockerId);
      if (blocker && !blocker.blocks.includes(task.id)) blocker.blocks.push(task.id);
    }
  }
  return tasks;
}

function parseJson<T>(result: BdCommandResult, command: string): T {
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const lower = `${stderr} ${result.stdout}`.toLowerCase();
    const kind = result.exitCode === 124 || lower.includes("timed out") || lower.includes("timeout")
      ? "timeout"
      : result.exitCode === 127 || lower.includes("not found") || lower.includes("no such file")
        ? "unavailable"
        : "command";
    throw new BeadsError(
      `Beads command failed (${kind}): ${command}${stderr ? ` — ${stderr}` : ""}. ` +
        "Check that bd is installed and the configured workspace contains an initialized Beads repository.",
      kind,
      command,
      stderr || undefined,
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

  private async showRaw(taskId: string): Promise<RawBead> {
    const safeId = sanitizeName(taskId);
    const result = await this.command<RawBead[]>(["show", safeId, "--long", "--include-comments", "--include-dependents"]);
    const raw = Array.isArray(result) ? result[0] : undefined;
    if (!raw || !raw.id) throw new BeadsError(`Beads task ${taskId} was not found.`, "command", `bd show ${taskId}`);
    this.verifyScope(raw);
    return raw;
  }

  private async listRaw(): Promise<RawBead[]> {
    const result = await this.command<RawBead[]>(["list", "--label", beadsLabel(this.teamName), "--all", "--no-pager", "--limit", "0"]);
    if (!Array.isArray(result)) throw new BeadsError("Beads list returned a non-array JSON value.", "malformed", "bd list");
    for (const raw of result) this.verifyScope(raw);
    return result;
  }

  async findByLegacyId(legacyId: string): Promise<TaskFile | undefined> {
    const raw = (await this.listRaw()).find(raw => metadataValue(raw, "pi_teams_legacy_id") === legacyId);
    return raw ? mapTask(raw) : undefined;
  }

  async create(input: CreateTaskInput, options: TaskWriteOptions = {}): Promise<TaskFile> {
    if (!input.subject || !input.subject.trim()) throw new Error("Task subject must not be empty");
    const idempotencyKey = input.idempotencyKey || options.idempotencyKey;
    const create = async (): Promise<TaskFile> => {
      if (idempotencyKey) {
        const existing = (await this.listRaw()).filter(raw => metadataValue(raw, "pi_teams_idempotency_key") === idempotencyKey);
        if (existing.length > 1) throw new BeadsError(`Duplicate Beads tasks share idempotency key ${idempotencyKey}; refusing to choose a mapping.`, "conflict", `bd list ${idempotencyKey}`);
        if (existing[0]) return mapTask(existing[0]);
      }
      const metadata = {
      ...(input.metadata || {}),
      pi_teams_team: this.teamName,
      pi_teams_source: "pi-teams",
      pi_teams_schema: PI_TEAMS_SCHEMA,
      ...(input.activeForm ? { pi_teams_active_form: input.activeForm } : {}),
      ...(idempotencyKey ? { pi_teams_idempotency_key: idempotencyKey } : {}),
      ...(input.metadata ? { pi_teams_metadata: JSON.stringify(input.metadata) } : {}),
      };
      const raw = await this.command<RawBead | RawBead[]>([
      "create",
      "--title", input.subject,
      "--description", input.description,
      "--labels", beadsLabel(this.teamName),
      "--metadata", JSON.stringify(metadata),
      "--actor", actorName(options.actor || this.actor),
      ]);
      const created = Array.isArray(raw) ? raw[0] : raw;
      if (!created?.id) throw new BeadsError("Beads create returned no task ID.", "malformed", "bd create");
      this.verifyScope(created);
      return mapTask(await this.showRaw(created.id));
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
    if ((updates.status === "completed" || updates.status === "deleted") && Object.keys(updates).some((key) => key !== "status")) {
      throw new Error(`Beads ${updates.status} is a terminal transition and cannot be combined with other fields; split the writes and re-read expected_version.`);
    }
    const args: string[] = ["update", safeId, "--actor", actorName(options.actor || this.actor)];
    if (updates.subject !== undefined) args.push("--title", updates.subject);
    if (updates.description !== undefined) args.push("--description", updates.description);
    if (updates.owner !== undefined) args.push("--assignee", updates.owner || "");
    if (options.internalOwnerTransition) {
      args.push("--set-metadata", `${OWNER_TRANSITION_OPERATION_METADATA}=${options.internalOwnerTransition.operationId}`);
    }
    if (updates.activeForm !== undefined) args.push("--set-metadata", `pi_teams_active_form=${updates.activeForm}`);
    if (updates.plan !== undefined) args.push("--set-metadata", `pi_teams_plan=${updates.plan}`);
    if (updates.planFeedback !== undefined) args.push("--set-metadata", `pi_teams_plan_feedback=${updates.planFeedback}`);
    if (updates.metadata !== undefined) args.push("--set-metadata", `pi_teams_metadata=${JSON.stringify(updates.metadata)}`);
    if (updates.status === "planning") args.push("--status", "open", "--set-metadata", "pi_teams_phase=planning");
    if (updates.status === "pending") args.push("--status", "open", "--unset-metadata", "pi_teams_phase");
    if (updates.status === "in_progress") args.push("--status", "in_progress", "--unset-metadata", "pi_teams_phase");
    if (updates.status === "blocked") args.push("--status", "blocked", "--unset-metadata", "pi_teams_phase");
    if (updates.status === "completed") {
      if (beforeRaw.status !== "closed") {
        await this.command<RawBead | RawBead[]>(["close", safeId, "--reason", "completed by pi-teams", "--actor", actorName(options.actor || this.actor)]);
      }
    } else if (updates.status === "deleted") {
      await this.command<RawBead | RawBead[]>(["update", safeId, "--actor", actorName(options.actor || this.actor), "--set-metadata", "pi_teams_deleted=true"]);
      if (beforeRaw.status !== "closed") {
        await this.command<RawBead | RawBead[]>(["close", safeId, "--reason", "deleted by pi-teams", "--actor", actorName(options.actor || this.actor)]);
      }
    } else if (args.length > 4) {
      await this.command<RawBead | RawBead[]>(args);
    }
    // Beads command responses can expose a pre-commit updated_at. Only a
    // fresh show supplies a version token safe to advertise to callers.
    const after = await this.showRaw(safeId);
    const mapped = mapTask(after);
    if (updates.status === "completed" && beforeRaw.status !== "closed") await runHook(this.teamName, "task_completed", mapped);
    return {
      before: mapTask(beforeRaw),
      after: mapped,
      appliedOperations: Object.keys(updates).map((field) => `set:${field}`),
    };
  }

  async updateWithResult(taskId: string, updates: Partial<TaskFile>, options: TaskWriteOptions = {}): Promise<TaskMutationResult> {
    const safeId = sanitizeName(taskId);
    return withLock(this.lockPath(safeId), async () => {
      const beforeRaw = await this.showRaw(safeId);
      this.assertNotDeleted(beforeRaw, "update");
      this.assertExpectedVersion(beforeRaw, options, "update");
      const prepared = (
        updates.owner !== undefined
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

  async submitPlan(taskId: string, plan: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    if (!plan || !plan.trim()) throw new Error("Plan must not be empty");
    const safeId = sanitizeName(taskId);
    return withLock(this.lockPath(safeId), async () => {
      const beforeRaw = await this.showRaw(safeId);
      this.assertNotDeleted(beforeRaw, "submit-plan");
      this.assertNotImplicitCompletedReopen(beforeRaw, "task_submit_plan");
      this.assertExpectedVersion(beforeRaw, options, "submit-plan");
      return (await this.updateWithResultLocked(
        safeId,
        { status: "planning", plan, planFeedback: "" },
        options,
        beforeRaw,
      )).after;
    }, options.retries);
  }

  async evaluatePlan(taskId: string, action: "approve" | "reject", feedback?: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    if (action === "reject" && (!feedback || !feedback.trim())) throw new Error("Feedback is required when rejecting a plan.");
    const safeId = sanitizeName(taskId);
    return withLock(this.lockPath(safeId), async () => {
      const beforeRaw = await this.showRaw(safeId);
      this.assertNotDeleted(beforeRaw, "evaluate-plan");
      this.assertExpectedVersion(beforeRaw, options, "evaluate-plan");
      const task = mapTask(beforeRaw);
      if (task.status !== "planning") {
        throw new BeadsError(
          `Cannot evaluate plan for task ${taskId} because its status is '${task.status}'. Tasks must be in 'planning' status to be evaluated.`,
          "conflict",
          `bd evaluate-plan ${safeId}`,
        );
      }
      if (!task.plan || !task.plan.trim()) {
        throw new BeadsError(`Cannot evaluate plan for task ${taskId} because no plan has been submitted.`, "conflict", `bd evaluate-plan ${safeId}`);
      }
      if (task.planFeedback?.trim()) {
        throw new BeadsError(
          `Cannot evaluate plan for task ${taskId} because the current plan was already rejected. Submit a revised plan before evaluating it again.`,
          "conflict",
          `bd evaluate-plan ${safeId}`,
        );
      }
      const updates = action === "approve"
        ? { status: "in_progress" as const, planFeedback: "" }
        : { status: "planning" as const, planFeedback: feedback };
      return (await this.updateWithResultLocked(safeId, updates, options, beforeRaw)).after;
    }, options.retries);
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

  async addDependencyWithResult(taskId: string, blockerId: string, options: TaskWriteOptions = {}): Promise<TaskMutationResult> {
    const safeTaskId = sanitizeName(taskId);
    const safeBlockerId = sanitizeName(blockerId);
    if (safeTaskId === safeBlockerId) throw new Error("A task cannot depend on itself");
    let before!: TaskFile;
    let changed = false;
    await withLock(this.lockPath(safeTaskId), async () => {
      const taskRaw = await this.showRaw(safeTaskId);
      this.assertNotDeleted(taskRaw, "link");
      this.assertExpectedVersion(taskRaw, options, "link");
      await this.showRaw(safeBlockerId);
      const task = mapTask(taskRaw);
      before = task;
      if (task.blockedBy.includes(safeBlockerId)) return;
      await this.command(["link", safeTaskId, safeBlockerId, "--type", "blocks", "--actor", actorName(options.actor || this.actor)]);
      changed = true;
    }, options.retries);
    const after = await this.read(safeTaskId);
    return { before, after, appliedOperations: changed ? [`add:blocked_by:${safeBlockerId}`] : [] };
  }

  async addDependency(taskId: string, blockerId: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    return (await this.addDependencyWithResult(taskId, blockerId, options)).after;
  }

  async addProgressWithResult(taskId: string, entry: BeadsProgressEntry, options: TaskWriteOptions = {}): Promise<TaskMutationResult> {
    const prefix = entry.kind === "pending-problem" ? "[pi-teams pending-problem]" : "[pi-teams progress]";
    const safeId = sanitizeName(taskId);
    let before!: TaskFile;
    await withLock(this.lockPath(safeId), async () => {
      const beforeRaw = await this.showRaw(safeId);
      this.assertNotDeleted(beforeRaw, "comment");
      this.assertExpectedVersion(beforeRaw, options, "comment");
      before = mapTask(beforeRaw);
      await this.command(["comment", safeId, `${prefix} ${entry.text}`, "--actor", actorName(entry.actor || options.actor || this.actor)]);
    }, options.retries);
    return { before, after: await this.read(safeId), appliedOperations: [`append:${entry.kind}`] };
  }

  async addProgress(taskId: string, entry: BeadsProgressEntry, options: TaskWriteOptions = {}): Promise<TaskFile> {
    return (await this.addProgressWithResult(taskId, entry, options)).after;
  }

}
