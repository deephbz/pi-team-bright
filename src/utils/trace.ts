import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

export const PI_TEAMS_TRACE_JSONL_ENV = "PI_TEAMS_TRACE_JSONL";

interface BdCallTrace {
  command: string;
  durationMs: number;
  outcome: "ok" | "error";
}

interface TraceContext {
  operation: string;
  teamName?: string;
  taskId?: string;
  startedAt: number;
  bdCalls: BdCallTrace[];
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

export function recordLockWait(durationMs: number): void {
  const context = storage.getStore();
  if (context) context.lockWaitMs += durationMs;
}

/** Emit one payload-free canonical JSONL record for a semantic operation. */
export async function withSemanticTrace<T>(
  operation: string,
  identity: { teamName?: string; taskId?: string },
  action: () => Promise<T>,
): Promise<T> {
  if (!process.env[PI_TEAMS_TRACE_JSONL_ENV]) return action();
  const context: TraceContext = { operation, ...identity, startedAt: Date.now(), bdCalls: [], lockWaitMs: 0 };
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
