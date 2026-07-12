// Project: pi-teams
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TaskFile } from "./models";
import { taskDir, sanitizeName } from "./paths";
import { teamExists, readConfig } from "./teams";
import { withLock, withLocks } from "./lock";
import { runHook } from "./hooks";
import {
  BeadsTaskStore,
  CreateTaskInput,
  TaskWriteOptions,
  BeadsTaskStoreOptions,
  BeadsProgressEntry,
} from "./beads";

export type UpdateTaskOptions = TaskWriteOptions | number;

export interface TaskStore {
  create(input: CreateTaskInput, options?: TaskWriteOptions): Promise<TaskFile>;
  update(taskId: string, updates: Partial<TaskFile>, options?: TaskWriteOptions): Promise<TaskFile>;
  submitPlan(taskId: string, plan: string, options?: TaskWriteOptions): Promise<TaskFile>;
  evaluatePlan(taskId: string, action: "approve" | "reject", feedback?: string, options?: TaskWriteOptions): Promise<TaskFile>;
  read(taskId: string, retries?: number): Promise<TaskFile>;
  list(): Promise<TaskFile[]>;
  claim?(taskId: string, actor?: string, options?: TaskWriteOptions): Promise<TaskFile>;
  addDependency?(taskId: string, blockerId: string, options?: TaskWriteOptions): Promise<TaskFile>;
  addProgress?(taskId: string, entry: BeadsProgressEntry, options?: TaskWriteOptions): Promise<TaskFile>;
  resetOwnerTasks(agentName: string): Promise<void>;
}

function versionOf(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function withLegacyVersion(raw: string, task: TaskFile): TaskFile {
  return { ...task, version: versionOf(raw) };
}

export class LegacyTaskStore implements TaskStore {
  constructor(readonly teamName: string) {}

  private getTaskPath(taskId: string): string {
    const dir = taskDir(this.teamName);
    return path.join(dir, `${sanitizeName(taskId)}.json`);
  }

  async create(input: CreateTaskInput): Promise<TaskFile> {
    if (!input.subject || !input.subject.trim()) throw new Error("Task subject must not be empty");
    if (!teamExists(this.teamName)) throw new Error(`Team ${this.teamName} does not exist`);

    const dir = taskDir(this.teamName);
    return await withLock(dir, async () => {
      const id = getTaskId(this.teamName);
      const task: TaskFile = {
        id,
        subject: input.subject,
        description: input.description,
        activeForm: input.activeForm,
        status: "pending",
        blocks: [],
        blockedBy: [],
        metadata: input.metadata,
      };
      const serialized = JSON.stringify(task, null, 2);
      fs.writeFileSync(path.join(dir, `${id}.json`), serialized);
      return withLegacyVersion(serialized, task);
    });
  }

  async update(taskId: string, updates: Partial<TaskFile>, options: TaskWriteOptions = {}): Promise<TaskFile> {
    const p = this.getTaskPath(taskId);
    return await withLock(p, async () => {
      if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
      const raw = fs.readFileSync(p, "utf-8");
      const task: TaskFile = JSON.parse(raw);
      if (options.expectedVersion && versionOf(raw) !== options.expectedVersion) {
        throw new Error(`Task ${taskId} changed since version ${options.expectedVersion}; re-read and retry.`);
      }
      const updated = { ...task, ...updates };

      if (updates.status === "deleted") {
        fs.unlinkSync(p);
        return { ...updated, version: undefined };
      }

      const serialized = JSON.stringify(updated, null, 2);
      fs.writeFileSync(p, serialized);

      if (updates.status === "completed") await runHook(this.teamName, "task_completed", updated);
      return withLegacyVersion(serialized, updated);
    }, options.retries);
  }

  async submitPlan(taskId: string, plan: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    if (!plan || !plan.trim()) throw new Error("Plan must not be empty");
    return this.update(taskId, { status: "planning", plan }, options);
  }

  async evaluatePlan(taskId: string, action: "approve" | "reject", feedback?: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    const p = this.getTaskPath(taskId);
    return await withLock(p, async () => {
      if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
      const raw = fs.readFileSync(p, "utf-8");
      const task: TaskFile = JSON.parse(raw);
      if (options.expectedVersion && versionOf(raw) !== options.expectedVersion) {
        throw new Error(`Task ${taskId} changed since version ${options.expectedVersion}; re-read and retry.`);
      }
      if (task.status !== "planning") {
        throw new Error(`Cannot evaluate plan for task ${taskId} because its status is '${task.status}'. Tasks must be in 'planning' status to be evaluated.`);
      }
      if (!task.plan || !task.plan.trim()) throw new Error(`Cannot evaluate plan for task ${taskId} because no plan has been submitted.`);
      if (action === "reject" && (!feedback || !feedback.trim())) throw new Error("Feedback is required when rejecting a plan.");
      const updates: Partial<TaskFile> = action === "approve"
        ? { status: "in_progress", planFeedback: "" }
        : { status: "planning", planFeedback: feedback };
      const updated = { ...task, ...updates };
      const serialized = JSON.stringify(updated, null, 2);
      fs.writeFileSync(p, serialized);
      return withLegacyVersion(serialized, updated);
    });
  }

  async read(taskId: string, retries = 50): Promise<TaskFile> {
    const p = this.getTaskPath(taskId);
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    return await withLock(p, async () => {
      const raw = fs.readFileSync(p, "utf-8");
      return withLegacyVersion(raw, JSON.parse(raw));
    }, retries);
  }

  async list(): Promise<TaskFile[]> {
    const dir = taskDir(this.teamName);
    return await withLock(dir, async () => {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
      const tasks = files.map(file => {
        const id = parseInt(path.parse(file).name, 10);
        if (Number.isNaN(id)) return null;
        const raw = fs.readFileSync(path.join(dir, file), "utf-8");
        return withLegacyVersion(raw, JSON.parse(raw));
      }).filter((task): task is TaskFile => task !== null);
      return tasks.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    });
  }

  async claim(taskId: string, actor?: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    const task = await this.read(taskId);
    if (task.owner && task.owner !== actor) throw new Error(`Task ${taskId} is already claimed by ${task.owner}`);
    return this.update(taskId, { owner: actor, status: "in_progress" }, options);
  }

  async addDependency(taskId: string, blockerId: string, options: TaskWriteOptions = {}): Promise<TaskFile> {
    if (taskId === blockerId) throw new Error("A task cannot depend on itself");
    const taskPath = this.getTaskPath(taskId);
    const blockerPath = this.getTaskPath(blockerId);
    return withLocks([taskPath, blockerPath], async () => {
      if (!fs.existsSync(taskPath)) throw new Error(`Task ${taskId} not found`);
      if (!fs.existsSync(blockerPath)) throw new Error(`Task ${blockerId} not found`);
      const taskRaw = fs.readFileSync(taskPath, "utf8");
      const blockerRaw = fs.readFileSync(blockerPath, "utf8");
      const task = withLegacyVersion(taskRaw, JSON.parse(taskRaw) as TaskFile);
      const blocker = withLegacyVersion(blockerRaw, JSON.parse(blockerRaw) as TaskFile);
      if (options.expectedVersion && task.version !== options.expectedVersion) {
        throw new Error(`Task ${taskId} changed since version ${options.expectedVersion}; re-read and retry.`);
      }
      try {
        if (!task.blockedBy.includes(blockerId)) {
          const updatedTask = { ...task, blockedBy: [...task.blockedBy, blockerId] };
          fs.writeFileSync(taskPath, JSON.stringify(updatedTask, null, 2));
        }
        if (!blocker.blocks.includes(taskId)) {
          const updatedBlocker = { ...blocker, blocks: [...blocker.blocks, taskId] };
          fs.writeFileSync(blockerPath, JSON.stringify(updatedBlocker, null, 2));
        }
      } catch (error) {
        fs.writeFileSync(taskPath, taskRaw);
        fs.writeFileSync(blockerPath, blockerRaw);
        throw error;
      }
      const finalRaw = fs.readFileSync(taskPath, "utf8");
      return withLegacyVersion(finalRaw, JSON.parse(finalRaw) as TaskFile);
    });
  }

  async addProgress(taskId: string, entry: BeadsProgressEntry, options: TaskWriteOptions = {}): Promise<TaskFile> {
    const task = await this.read(taskId);
    const key = entry.kind === "pending-problem" ? "pendingProblems" : "progress";
    const current = Array.isArray(task.metadata?.[key]) ? task.metadata?.[key] : [];
    return this.update(taskId, {
      metadata: {
        ...(task.metadata || {}),
        [key]: [...current, { text: entry.text, actor: entry.actor, at: new Date().toISOString() }],
      },
    }, options);
  }

  async resetOwnerTasks(agentName: string): Promise<void> {
    const dir = taskDir(this.teamName);
    await withLock(dir, async () => {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        const p = path.join(dir, file);
        const raw = fs.readFileSync(p, "utf-8");
        const task: TaskFile = JSON.parse(raw);
        if (task.owner === agentName) {
          task.owner = undefined;
          if (task.status !== "completed") task.status = "pending";
          fs.writeFileSync(p, JSON.stringify(task, null, 2));
        }
      }
    });
  }
}

export function getTaskId(teamName: string): string {
  const dir = taskDir(teamName);
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  const ids = files.map(f => parseInt(path.parse(f).name, 10)).filter(id => !Number.isNaN(id));
  return ids.length > 0 ? (Math.max(...ids) + 1).toString() : "1";
}

async function storeFor(teamName: string): Promise<TaskStore> {
  const config = await readConfig(teamName);
  if (config.taskBackend !== "beads") return new LegacyTaskStore(teamName);
  if (!config.taskWorkspace) {
    throw new Error(`Team ${teamName} is configured for Beads but has no taskWorkspace. Re-run migration configuration; legacy task files are not a fallback.`);
  }
  return new BeadsTaskStore({ teamName, workspace: config.taskWorkspace, requireExpectedVersion: true });
}

function optionsFrom(value?: UpdateTaskOptions): { retries?: number; options: TaskWriteOptions } {
  return typeof value === "number" ? { retries: value, options: {} } : { options: value || {} };
}

export async function createTask(teamName: string, subject: string, description: string, activeForm = "", metadata?: Record<string, any>): Promise<TaskFile> {
  const store = await storeFor(teamName);
  const idempotencyKey = typeof metadata?.pi_teams_idempotency_key === "string" ? metadata.pi_teams_idempotency_key : undefined;
  return store.create({ subject, description, activeForm, metadata, idempotencyKey }, { idempotencyKey });
}

export async function updateTask(teamName: string, taskId: string, updates: Partial<TaskFile>, retriesOrOptions?: UpdateTaskOptions): Promise<TaskFile> {
  const parsed = optionsFrom(retriesOrOptions);
  const store = await storeFor(teamName);
  if (parsed.retries !== undefined && store instanceof LegacyTaskStore) {
    // Preserve the historical fourth positional retry argument for callers/tests.
    return store.update(taskId, updates, { ...parsed.options, retries: parsed.retries });
  }
  return store.update(taskId, updates, parsed.options);
}

export async function submitPlan(teamName: string, taskId: string, plan: string, options?: TaskWriteOptions): Promise<TaskFile> {
  return (await storeFor(teamName)).submitPlan(taskId, plan, options);
}

export async function evaluatePlan(teamName: string, taskId: string, action: "approve" | "reject", feedback?: string, options?: TaskWriteOptions): Promise<TaskFile> {
  return (await storeFor(teamName)).evaluatePlan(taskId, action, feedback, options);
}

export async function readTask(teamName: string, taskId: string, retries?: number): Promise<TaskFile> {
  return (await storeFor(teamName)).read(taskId, retries);
}

export async function listTasks(teamName: string): Promise<TaskFile[]> {
  return (await storeFor(teamName)).list();
}

export async function claimTask(teamName: string, taskId: string, actor: string, options?: TaskWriteOptions): Promise<TaskFile> {
  const store = await storeFor(teamName);
  if (!store.claim) throw new Error(`Task backend for team ${teamName} does not support atomic claims.`);
  return store.claim(taskId, actor, options);
}

export async function addTaskDependency(teamName: string, taskId: string, blockerId: string, options?: TaskWriteOptions): Promise<TaskFile> {
  const store = await storeFor(teamName);
  if (!store.addDependency) throw new Error(`Task backend for team ${teamName} does not support dependencies.`);
  return store.addDependency(taskId, blockerId, options);
}

export async function addTaskProgress(teamName: string, taskId: string, entry: BeadsProgressEntry, options?: TaskWriteOptions): Promise<TaskFile> {
  const store = await storeFor(teamName);
  if (!store.addProgress) throw new Error(`Task backend for team ${teamName} does not support progress entries.`);
  return store.addProgress(taskId, entry, options);
}

export async function resetOwnerTasks(teamName: string, agentName: string): Promise<void> {
  return (await storeFor(teamName)).resetOwnerTasks(agentName);
}

export function createBeadsStore(options: BeadsTaskStoreOptions): BeadsTaskStore {
  return new BeadsTaskStore(options);
}
