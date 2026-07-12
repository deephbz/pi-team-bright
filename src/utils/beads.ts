import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { TaskFile } from "./models";
import { withLock } from "./lock";
import { teamDir, sanitizeName } from "./paths";
import { runHook } from "./hooks";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

export const DEFAULT_BD_TIMEOUT_MS = 10_000;
export const PI_TEAMS_SCHEMA = "1";

export interface BdCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BdRunner {
  run(args: string[], options: { cwd: string; timeoutMs: number }): Promise<BdCommandResult>;
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
      const stdout = typeof error?.stdout === "string" ? error.stdout : "";
      const stderr = typeof error?.stderr === "string" ? error.stderr : "";
      const timedOut = error?.killed || error?.code === "ETIMEDOUT";
      const exitCode = typeof error?.code === "number" ? error.code : timedOut ? 124 : 1;
      return { stdout, stderr, exitCode };
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
  dependencies?: Array<{ id?: string; issue_id?: string; depends_on_id?: string; dependency_type?: string; type?: string; status?: string }>;
  comments?: Array<{ id: string; author: string; text: string; created_at: string }>;
  error?: string;
}

export interface BeadsTaskStoreOptions {
  teamName: string;
  workspace: string;
  actor?: string;
  timeoutMs?: number;
  runner?: BdRunner;
  /** Enforced by the post-cutover task factory; migration can explicitly disable it. */
  requireExpectedVersion?: boolean;
}

export interface TaskWriteOptions {
  actor?: string;
  expectedVersion?: string;
  idempotencyKey?: string;
  retries?: number;
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

function mapTask(raw: RawBead): TaskFile {
  const blockedBy = (raw.dependencies || [])
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
    blocks: [],
    blockedBy,
    owner: raw.assignee,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    version: raw.updated_at,
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
      : lower.includes("not found") || lower.includes("no such file")
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

  constructor(options: BeadsTaskStoreOptions) {
    if (!path.isAbsolute(options.workspace)) {
      throw new Error(`Beads task workspace must be an absolute path: ${options.workspace}`);
    }
    this.teamName = sanitizeName(options.teamName);
    this.workspace = options.workspace;
    this.actor = actorName(options.actor);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BD_TIMEOUT_MS;
    this.runner = options.runner ?? defaultBdRunner;
    this.requireExpectedVersion = options.requireExpectedVersion ?? true;
  }

  private async command<T>(args: string[]): Promise<T> {
    const fullArgs = ["--directory", this.workspace, "--json", ...args];
    const display = ["bd", ...fullArgs].join(" ");
    return parseJson<T>(await this.runner.run(fullArgs, { cwd: this.workspace, timeoutMs: this.timeoutMs }), display);
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
      return mapTask(created);
    };
    if (!idempotencyKey) return create();
    fs.mkdirSync(teamDir(this.teamName), { recursive: true });
    const keyHash = crypto.createHash("sha256").update(idempotencyKey).digest("hex");
    return withLock(path.join(teamDir(this.teamName), `.beads-create-${keyHash}`), create);
  }

  private assertExpectedVersion(before: RawBead, options: TaskWriteOptions, operation: string): void {
    if (this.requireExpectedVersion && !options.expectedVersion) {
      throw new BeadsError(`expected_version is required for Beads ${operation} after cutover. Read the task again and retry.`, "conflict", `bd ${operation}`);
    }
    if (options.expectedVersion && before.updated_at !== options.expectedVersion) {
      throw new BeadsError(
        `Task ${before.id} changed since version ${options.expectedVersion}; refusing ${operation}. Beads 1.1.0 has no true conditional write, so this token is a best-effort preflight and external writers can still race after the check. Re-read and retry.`,
        "conflict",
        `bd ${operation} ${before.id}`,
      );
    }
  }

  async read(taskId: string): Promise<TaskFile> {
    const task = mapTask(await this.showRaw(taskId));
    const all = mapWithReverseDependencies(await this.listRaw());
    const relationship = all.find(candidate => candidate.id === task.id);
    return relationship ? { ...task, blocks: relationship.blocks, blockedBy: relationship.blockedBy } : task;
  }

  async list(): Promise<TaskFile[]> {
    const raws = (await this.listRaw()).filter(raw => metadataValue(raw, "pi_teams_deleted") !== "true");
    return mapWithReverseDependencies(raws)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async update(taskId: string, updates: Partial<TaskFile>, options: TaskWriteOptions = {}): Promise<TaskFile> {
    const safeId = sanitizeName(taskId);
    return withLock(this.lockPath(safeId), async () => {
      const before = await this.showRaw(safeId);
      this.assertExpectedVersion(before, options, "update");
      const args: string[] = ["update", safeId, "--actor", actorName(options.actor || this.actor)];
      if (updates.subject !== undefined) args.push("--title", updates.subject);
      if (updates.description !== undefined) args.push("--description", updates.description);
      if (updates.owner !== undefined) args.push("--assignee", updates.owner || "");
      if (updates.activeForm !== undefined) args.push("--set-metadata", `pi_teams_active_form=${updates.activeForm}`);
      if (updates.plan !== undefined) args.push("--set-metadata", `pi_teams_plan=${updates.plan}`);
      if (updates.planFeedback !== undefined) args.push("--set-metadata", `pi_teams_plan_feedback=${updates.planFeedback}`);
      if (updates.metadata !== undefined) args.push("--set-metadata", `pi_teams_metadata=${JSON.stringify(updates.metadata)}`);
      if (updates.status === "planning") args.push("--status", "open", "--set-metadata", "pi_teams_phase=planning");
      if (updates.status === "pending") args.push("--status", "open", "--unset-metadata", "pi_teams_phase");
      if (updates.status === "in_progress") args.push("--status", "in_progress", "--unset-metadata", "pi_teams_phase");
      if (updates.status === "completed") {
        if (args.length > 4) await this.command(args);
        if (before.status !== "closed") {
          await this.command(["close", safeId, "--reason", "completed by pi-teams", "--actor", actorName(options.actor || this.actor)]);
        }
      } else if (updates.status === "deleted") {
        args.push("--set-metadata", "pi_teams_deleted=true");
        await this.command(args);
        if (before.status !== "closed") {
          await this.command(["close", safeId, "--reason", "deleted by pi-teams", "--actor", actorName(options.actor || this.actor)]);
        }
      } else if (args.length > 4) {
        await this.command(args);
      }
      const after = await this.showRaw(safeId);
      const mapped = mapTask(after);
      if (updates.status === "completed" && before.status !== "closed") await runHook(this.teamName, "task_completed", mapped);
      return mapped;
    });
  }

  async submitPlan(taskId: string, plan: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    if (!plan || !plan.trim()) throw new Error("Plan must not be empty");
    return this.update(taskId, { status: "planning", plan }, options);
  }

  async evaluatePlan(taskId: string, action: "approve" | "reject", feedback?: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    const task = await this.read(taskId);
    if (task.status !== "planning") {
      throw new Error(`Cannot evaluate plan for task ${taskId} because its status is '${task.status}'. Tasks must be in 'planning' status to be evaluated.`);
    }
    if (!task.plan || !task.plan.trim()) throw new Error(`Cannot evaluate plan for task ${taskId} because no plan has been submitted.`);
    if (action === "reject" && (!feedback || !feedback.trim())) throw new Error("Feedback is required when rejecting a plan.");
    if (action === "approve") return this.update(taskId, { status: "in_progress", planFeedback: "" }, options);
    return this.update(taskId, { status: "planning", planFeedback: feedback }, options);
  }

  async claim(taskId: string, actor?: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    const safeId = sanitizeName(taskId);
    return withLock(this.lockPath(safeId), async () => {
      const before = await this.showRaw(safeId);
      if (options.expectedVersion && before.updated_at !== options.expectedVersion) {
        throw new BeadsError(`Task ${taskId} changed before claim; re-read and retry.`, "conflict", `bd update ${taskId} --claim`);
      }
      await this.command(["update", safeId, "--claim", "--actor", actorName(actor || options.actor || this.actor)]);
      return mapTask(await this.showRaw(safeId));
    });
  }

  async addDependency(taskId: string, blockerId: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    const safeTaskId = sanitizeName(taskId);
    const safeBlockerId = sanitizeName(blockerId);
    if (safeTaskId === safeBlockerId) throw new Error("A task cannot depend on itself");
    await withLock(this.lockPath(safeTaskId), async () => {
      const taskRaw = await this.showRaw(safeTaskId);
      this.assertExpectedVersion(taskRaw, options, "link");
      await this.showRaw(safeBlockerId);
      const task = mapTask(taskRaw);
      if (task.blockedBy.includes(safeBlockerId)) return;
      await this.command(["link", safeTaskId, safeBlockerId, "--type", "blocks", "--actor", actorName(options.actor || this.actor)]);
    }, options.retries);
    return this.read(safeTaskId);
  }

  async addProgress(taskId: string, entry: BeadsProgressEntry, options: TaskWriteOptions = {}): Promise<TaskFile> {
    const prefix = entry.kind === "pending-problem" ? "[pi-teams pending-problem]" : "[pi-teams progress]";
    const safeId = sanitizeName(taskId);
    await withLock(this.lockPath(safeId), async () => {
      const before = await this.showRaw(safeId);
      this.assertExpectedVersion(before, options, "comment");
      await this.command(["comment", safeId, `${prefix} ${entry.text}`, "--actor", actorName(entry.actor || options.actor || this.actor)]);
    }, options.retries);
    return this.read(safeId);
  }

  async resetOwnerTasks(agent: string): Promise<void> {
    for (const task of await this.list()) {
      if (task.owner === agent && task.status !== "completed") await this.update(task.id, { owner: "", status: "pending" }, { actor: this.actor, expectedVersion: task.version });
    }
  }
}
