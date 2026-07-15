import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  BeadsTaskStore,
  defaultBdRunner,
  type BdCommandResult,
  type BdRunner,
} from "../src/utils/beads";

type Mode = "embedded" | "server";

interface BdCall {
  verb: string;
  durationMs: number;
  outcome: "ok" | "error";
}

interface IntentRecord {
  lane: number;
  ordinal: number;
  verb: string;
  durationMs: number;
  bdCalls: number;
  bdDurationMs: number;
  outcome: "ok" | "error";
}

class MeasuringRunner implements BdRunner {
  readonly calls: BdCall[] = [];

  async run(args: string[], options: { cwd: string; timeoutMs: number }): Promise<BdCommandResult> {
    const started = performance.now();
    const result = await defaultBdRunner.run(args, options);
    const jsonFlag = args.indexOf("--json");
    const verb = jsonFlag >= 0 ? args[jsonFlag + 1] : args[0];
    this.calls.push({
      verb: verb || "unknown",
      durationMs: performance.now() - started,
      outcome: result.exitCode === 0 ? "ok" : "error",
    });
    return result;
  }
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

function stats(values: number[]) {
  return {
    count: values.length,
    meanMs: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: quantile(values, 0.5),
    p95Ms: quantile(values, 0.95),
    p99Ms: quantile(values, 0.99),
    maxMs: values.length === 0 ? 0 : Math.max(...values),
  };
}

function command(...args: string[]): void {
  execFileSync(args[0], args.slice(1), { stdio: "ignore" });
}

function commandAt(cwd: string, ...args: string[]): void {
  execFileSync(args[0], args.slice(1), { cwd, stdio: "ignore" });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate loopback port"));
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Dolt server didn't become ready within ${timeoutMs}ms`);
}

async function setup(mode: Mode): Promise<{ root: string; workspace: string; server?: ChildProcess }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-teams-clean-cut-${mode}-`));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  command("git", "-C", workspace, "init", "-q");
  if (mode === "embedded") {
    commandAt(workspace, "bd", "init", "--quiet", "--skip-agents", "--skip-hooks", "--non-interactive");
    return { root, workspace };
  }

  const dataDir = path.join(root, "dolt-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const server = spawn("dolt", ["sql-server", "--data-dir", dataDir, "-H", "127.0.0.1", "-P", String(port), "--loglevel", "warning"], {
    stdio: "ignore",
  });
  await waitForPort(port);
  commandAt(
    workspace, "bd", "init", "--server", "--external", "--server-host", "127.0.0.1", "--server-port", String(port),
    "--database", `clean_cut_${process.pid}`, "--prefix", "bench", "--quiet", "--skip-agents", "--skip-hooks",
    "--non-interactive",
  );
  return { root, workspace, server };
}

async function run(mode: Mode, intentCount: number): Promise<Record<string, unknown>> {
  if (intentCount !== 500) throw new Error("The release benchmark contract requires exactly 500 semantic intents.");
  const environment = await setup(mode);
  const runners = [0, 1, 2, 3].map(() => new MeasuringRunner());
  const records: IntentRecord[] = [];
  const started = performance.now();
  let active = 0;
  let peakConcurrency = 0;

  try {
    async function intent<T>(lane: number, ordinal: number, verb: string, action: () => Promise<T>): Promise<T> {
      const runner = runners[lane];
      const callStart = runner.calls.length;
      const intentStart = performance.now();
      active += 1;
      peakConcurrency = Math.max(peakConcurrency, active);
      let outcome: "ok" | "error" = "ok";
      try {
        return await action();
      } catch (error) {
        outcome = "error";
        throw error;
      } finally {
        active -= 1;
        const calls = runner.calls.slice(callStart);
        records.push({
          lane,
          ordinal,
          verb,
          durationMs: performance.now() - intentStart,
          bdCalls: calls.length,
          bdDurationMs: calls.reduce((sum, call) => sum + call.durationMs, 0),
          outcome,
        });
      }
    }

    async function lane(laneId: number): Promise<void> {
      const store = new BeadsTaskStore({
        teamName: "benchmark-team",
        workspace: environment.workspace,
        actor: `worker-${laneId}`,
        runner: runners[laneId],
        requireExpectedVersion: false,
        timeoutMs: 30_000,
      });
      const taskIds: string[] = [];
      let ordinal = 0;
      for (let index = 0; index < 5; index++) {
        const task = await intent(laneId, ordinal++, "create", () => store.create({
          title: `Benchmark task ${laneId}-${index}`,
          description: "Synthetic release benchmark payload",
        }));
        taskIds.push(task.id);
      }
      for (let index = 0; index < 25; index++) {
        await intent(laneId, ordinal++, "read", () => store.read(taskIds[index % taskIds.length]));
      }
      for (let index = 0; index < 25; index++) {
        await intent(laneId, ordinal++, "list", () => store.list());
      }
      for (let index = 0; index < 25; index++) {
        await intent(laneId, ordinal++, "status_update", () => store.update(taskIds[index % taskIds.length], {
          status: index % 2 === 0 ? "in_progress" : "open",
        }));
      }
      for (let index = 0; index < 20; index++) {
        await intent(laneId, ordinal++, "assignee_status_update", () => store.update(taskIds[index % taskIds.length], {
          assignee: `worker-${laneId}`,
          status: "in_progress",
        }));
      }
      for (let index = 0; index < 12; index++) {
        await intent(laneId, ordinal++, "design_update", () => store.update(taskIds[index % taskIds.length], {
          design: `design-${laneId}-${index}`,
        }));
      }
      for (let index = 0; index < 13; index++) {
        await intent(laneId, ordinal++, "append_note", () => store.update(
          taskIds[index % taskIds.length],
          {},
          { appendNote: `note-${laneId}-${index}`, actor: `worker-${laneId}` },
        ));
      }
      if (ordinal !== 125) throw new Error(`Lane ${laneId} produced ${ordinal}, expected 125 intents.`);
    }

    await Promise.all([0, 1, 2, 3].map(lane));
    const wallMs = performance.now() - started;
    if (records.length !== 500) throw new Error(`Observed ${records.length}, expected 500 semantic intents.`);
    const calls = runners.flatMap((runner) => runner.calls);
    const byVerb = Object.fromEntries([...new Set(records.map((record) => record.verb))].sort().map((verb) => {
      const matching = records.filter((record) => record.verb === verb);
      return [verb, {
        intents: matching.length,
        latency: stats(matching.map((record) => record.durationMs)),
        bdCalls: matching.reduce((sum, record) => sum + record.bdCalls, 0),
        bdCallsPerIntent: matching.reduce((sum, record) => sum + record.bdCalls, 0) / matching.length,
      }];
    }));
    const commandCounts = Object.fromEntries([...new Set(calls.map((call) => call.verb))].sort().map((verb) => [
      verb,
      calls.filter((call) => call.verb === verb).length,
    ]));
    return {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      mode,
      measurementBoundary: "BeadsTaskStore method calls; not agent-facing Pi tool calls",
      semanticIntents: records.length,
      wallMs,
      peakConcurrency,
      errors: records.filter((record) => record.outcome === "error").length,
      intentLatency: stats(records.map((record) => record.durationMs)),
      bd: {
        version: execFileSync("bd", ["--version"], { encoding: "utf8" }).trim(),
        invocations: calls.length,
        invocationsPerIntent: calls.length / records.length,
        totalInvocationMs: calls.reduce((sum, call) => sum + call.durationMs, 0),
        invocationLatency: stats(calls.map((call) => call.durationMs)),
        commandCounts,
        errors: calls.filter((call) => call.outcome === "error").length,
      },
      byVerb,
      deliveryMetrics: {
        scope: "Task storage adapter only; no Session delivery loop was exercised",
        steerReasons: 0,
        selfEchoes: 0,
        priorOwnerNotices: 0,
        reconciliationBdCalls: 0,
        peakSpoolRecords: 0,
        pruneReasons: {},
      },
      privacy: {
        workspacePathIncluded: false,
        taskPayloadIncluded: false,
        userIdentityIncluded: false,
      },
    };
  } finally {
    environment.server?.kill("SIGTERM");
    fs.rmSync(environment.root, { recursive: true, force: true });
  }
}

const modeArg = process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1] || "server";
if (modeArg !== "embedded" && modeArg !== "server") throw new Error(`Unsupported mode: ${modeArg}`);
run(modeArg, 500).then((summary) => {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
