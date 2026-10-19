import fs from "node:fs/promises";
import path from "node:path";
import { hostEnv } from "../env/host-env";
import { GraphObservationRecovery } from "../task-authority/graph-control";
import { projectGraphTaskCards } from "../task-authority/graph-card";
import { TEAMS_DIR, sanitizeName } from "../utils/paths";

export const TASK_OBSERVATION_SCHEMA = "pi-team-tasks/1" as const;
export type TaskObservation = {
  id: string; title: string; status: string; owner?: string; deps: string[]; ready: boolean;
};
export type TaskObservationSnapshot = {
  schema: typeof TASK_OBSERVATION_SCHEMA; teamName: string; generatedAt: string;
  availability: "available" | "unavailable"; tasks: TaskObservation[];
  issues: string[];
};
export interface ReadTaskOptions { teamName: string; teamsRoot?: string; deadlineMs?: number; signal?: AbortSignal; }
const cache = new Map<string, { identity: string; tasks: TaskObservation[] }>();
const fingerprint = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");

/** Read-only atomic-snapshot projection. A missing/corrupt authority is never an empty graph.
 * Warm reads stat only. No leases, directory creation, runtime probes, or delivery effects.
 */
export async function readTaskSnapshot(options: ReadTaskOptions): Promise<TaskObservationSnapshot> {
  const clock = hostEnv().clock;
  const result: TaskObservationSnapshot = { schema: TASK_OBSERVATION_SCHEMA, teamName: options.teamName,
    generatedAt: new Date(clock.now()).toISOString(), availability: "unavailable", tasks: [], issues: [] };
  let file: string | undefined;
  const deadline = clock.now() + (options.deadlineMs ?? 1000);
  const check = () => { if (options.signal?.aborted || clock.now() > deadline) throw new Error("task_read_interrupted"); };
  try {
    file = path.join(options.teamsRoot ?? TEAMS_DIR, sanitizeName(options.teamName), "task-authority", "graph-control.json");
    check();
    const before = await fs.stat(file, { bigint: true });
    if (!before.isFile() || before.size > 24_000_000n) throw new Error("task_authority_unreadable");
    const identity = fingerprint(before);
    let tasks = cache.get(file)?.identity === identity ? cache.get(file)!.tasks : undefined;
    if (!tasks) {
      const snapshot = JSON.parse(await fs.readFile(file, "utf8"));
      check();
      const state = new GraphObservationRecovery().recover(snapshot);
      const ready = new Set(state.selectReadyFrontier().map(task => task.id));
      tasks = projectGraphTaskCards(state).map(task => ({ id: task.id, title: task.title,
        status: task.status, owner: task.assignee, deps: [...task.needs], ready: ready.has(task.id) }));
    }
    if (fingerprint(await fs.stat(file, { bigint: true })) !== identity) throw new Error("task_authority_changed");
    check();
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(file, { identity, tasks });
    return { ...result, availability: "available", tasks: structuredClone(tasks) };
  } catch (error) {
    if (file) cache.delete(file);
    const code = (error as NodeJS.ErrnoException).code;
    result.issues = [code === "ENOENT" ? "task_authority_missing" : options.signal?.aborted || clock.now() > deadline
      ? "task_read_interrupted" : "task_authority_unavailable"];
    return result;
  }
}
