import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

export const PI_TEAMS_TRACE_JSONL_ENV = "PI_TEAMS_TRACE_JSONL";

/** Payload-free stages from parent launch through child Session admission. */
export type WorkerLaunchStage =
  | "ensure_started"
  | "carrier_reused"
  | "membership_prepared"
  | "carrier_start_accepted"
  | "carrier_label_applied"
  | "carrier_label_not_applied"
  | "carrier_target_persisted"
  | "session_bound_observed"
  | "session_bound_not_observed"
  | "compensation_started"
  | "carrier_stop_confirmed"
  | "recovery_authority_won"
  | "session_binding_won"
  | "membership_deactivated"
  | "compensation_unconfirmed"
  | "worker_session_started"
  | "membership_validated"
  | "runtime_admission_refused"
  | "runtime_generation_claimed"
  | "session_bound_persisted"
  | "session_bound_published";

interface WorkerLaunchStageTrace {
  stage: WorkerLaunchStage;
  elapsedMs: number;
  membershipId?: string;
}

interface BdCallTrace {
  command: string;
  durationMs: number;
  outcome: "ok" | "error";
}

interface BdRunnerLifecycleTrace {
  event: "start" | "deadline" | "termination_cleanup" | "settled";
  durationMs: number;
  timedOut: boolean;
}

interface TraceContext {
  operation: string;
  teamName?: string;
  taskId?: string;
  workerName?: string;
  startedAt: number;
  startedAtMonotonic: number;
  bdCalls: BdCallTrace[];
  bdRunnerLifecycle: BdRunnerLifecycleTrace[];
  workerLaunchStages: WorkerLaunchStageTrace[];
  lockWaitMs: number;
}

const storage = new AsyncLocalStorage<TraceContext>();

function configuredPath(): string | null {
  const file = process.env[PI_TEAMS_TRACE_JSONL_ENV]?.trim();
  if (!file) return null;
  if (!path.isAbsolute(file)) throw new Error(`${PI_TEAMS_TRACE_JSONL_ENV} must be an absolute path.`);
  return file;
}

function append(record: Record<string, unknown>): void {
  const file = configuredPath();
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "a" });
}

export function recordBdCall(command: string, durationMs: number, outcome: "ok" | "error"): void {
  storage.getStore()?.bdCalls.push({ command, durationMs, outcome });
}

/** Record payload-free owned-process lifecycle evidence in a semantic trace. */
export function recordBdRunnerLifecycle(event: BdRunnerLifecycleTrace["event"], durationMs: number, timedOut: boolean): void {
  storage.getStore()?.bdRunnerLifecycle.push({ event, durationMs, timedOut });
}

export function recordLockWait(durationMs: number): void {
  const context = storage.getStore();
  if (context) context.lockWaitMs += durationMs;
}

/** Record one monotonic, payload-free Worker launch stage in the active trace. */
export function recordWorkerLaunchStage(stage: WorkerLaunchStage, details: { membershipId?: string } = {}): void {
  const context = storage.getStore();
  if (!context) return;
  context.workerLaunchStages.push({
    stage,
    elapsedMs: Math.max(0, performance.now() - context.startedAtMonotonic),
    ...(details.membershipId ? { membershipId: details.membershipId } : {}),
  });
}

/** Emit one payload-free canonical JSONL record for a semantic operation. */
export async function withSemanticTrace<T>(
  operation: string,
  identity: { teamName?: string; taskId?: string; workerName?: string },
  action: () => Promise<T>,
): Promise<T> {
  if (!process.env[PI_TEAMS_TRACE_JSONL_ENV]) return action();
  const context: TraceContext = {
    operation,
    ...identity,
    startedAt: Date.now(),
    startedAtMonotonic: performance.now(),
    bdCalls: [],
    bdRunnerLifecycle: [],
    workerLaunchStages: [],
    lockWaitMs: 0,
  };
  return storage.run(context, async () => {
    let outcome: "ok" | "error" = "ok";
    let caught: unknown;
    try {
      return await action();
    } catch (error) {
      outcome = "error";
      caught = error;
      throw error;
    } finally {
      try {
        append({
          schemaVersion: 1,
          timestamp: new Date().toISOString(),
          operation,
          ...identity,
          durationMs: Date.now() - context.startedAt,
          bdCallCount: context.bdCalls.length,
          bdTotalMs: context.bdCalls.reduce((sum, call) => sum + call.durationMs, 0),
          bdCalls: context.bdCalls,
          bdRunnerLifecycle: context.bdRunnerLifecycle,
          ...(context.workerLaunchStages.length > 0 ? {
            monotonicDurationMs: Math.max(0, performance.now() - context.startedAtMonotonic),
            workerLaunchStages: context.workerLaunchStages,
          } : {}),
          lockWaitMs: context.lockWaitMs,
          outcome,
          ...(caught ? { error: {
            name: caught instanceof Error ? caught.name : "Error",
            kind: typeof (caught as any)?.kind === "string" ? (caught as any).kind : undefined,
          } } : {}),
        });
      } catch (traceError) {
        console.warn(`[pi-teams] trace write failed after ${operation}: ${traceError instanceof Error ? traceError.message : String(traceError)}`);
      }
    }
  });
}
