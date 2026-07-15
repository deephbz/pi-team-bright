import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import crypto from "node:crypto";
import type { Member, TeamConfig } from "../src/utils/models";
import { readBeadsAuthorityFingerprint } from "../src/utils/beads";
import * as paths from "../src/utils/paths";
import * as tasks from "../src/utils/tasks";
import * as teams from "../src/utils/teams";

type Mode = "embedded" | "server";

interface IntentRecord {
  lane: number;
  verb: string;
  durationMs: number;
  outcome: "ok" | "error";
}

interface TraceRecord {
  operation: string;
  durationMs: number;
  bdCallCount: number;
  bdTotalMs: number;
  bdCalls: Array<{ command: string; durationMs: number; outcome: string }>;
  lockWaitMs: number;
  outcome: string;
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

async function setup(mode: Mode, teamName: string): Promise<{
  root: string;
  workspace: string;
  traceFile: string;
  leadSessionFile: string;
  laneBindings: Array<{ actor: string; actingSessionFile: string; actingMembershipId: string }>;
  server?: ChildProcess;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-teams-agent-benchmark-${mode}-`));
  const workspace = path.join(root, "workspace");
  const traceFile = path.join(root, "trace.jsonl");
  const leadSessionFile = path.join(root, "lead-session.jsonl");
  fs.mkdirSync(workspace, { recursive: true });
  commandAt(workspace, "git", "init", "-q");
  let server: ChildProcess | undefined;
  if (mode === "embedded") {
    commandAt(workspace, "bd", "init", "--quiet", "--skip-agents", "--skip-hooks", "--non-interactive");
  } else {
    const dataDir = path.join(root, "dolt-data");
    fs.mkdirSync(dataDir, { recursive: true });
    const port = await freePort();
    server = spawn("dolt", ["sql-server", "--data-dir", dataDir, "-H", "127.0.0.1", "-P", String(port), "--loglevel", "warning"], { stdio: "ignore" });
    await waitForPort(port);
    commandAt(
      workspace,
      "bd", "init", "--server", "--external", "--server-host", "127.0.0.1", "--server-port", String(port),
      "--database", `agent_bench_${process.pid}`, "--prefix", "bench", "--quiet", "--skip-agents", "--skip-hooks", "--non-interactive",
    );
  }

  const makeMember = (name: string, sessionFile: string): Member => ({
    membershipId: `membership_${crypto.randomUUID()}`,
    agentId: `${name}@${teamName}`,
    name,
    agentType: name === "team-lead" ? "lead" : "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: workspace,
    subscriptions: [],
    isActive: true,
  });
  const members = [
    makeMember("team-lead", leadSessionFile),
    ...[0, 1, 2, 3].map((lane) => makeMember(`worker-${lane}`, path.join(root, `worker-${lane}.jsonl`))),
  ];
  const config: TeamConfig = {
    name: teamName,
    description: "500-intent agent-boundary benchmark",
    createdAt: Date.now(),
    leadAgentId: members[0].agentId,
    leadSessionId: "benchmark-lead-session",
    members,
    taskBackend: "beads",
    taskWorkspace: workspace,
    taskAuthorityId: `task_authority_${crypto.randomUUID()}`,
    taskAuthorityFingerprint: readBeadsAuthorityFingerprint(workspace),
  };
  fs.mkdirSync(paths.teamDir(teamName), { recursive: true });
  teams.writeConfigAtomic(paths.configPath(teamName), config);
  const laneBindings = members.slice(1).map((member) => ({
    actor: member.name,
    actingSessionFile: member.sessionFile!,
    actingMembershipId: member.membershipId!,
  }));
  return { root, workspace, traceFile, leadSessionFile, laneBindings, server };
}

function readTrace(file: string): TraceRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function run(mode: Mode): Promise<Record<string, unknown>> {
  const teamName = `agent-bench-${process.pid}-${Date.now()}`;
  const environment = await setup(mode, teamName);
  const previousTrace = process.env.PI_TEAMS_TRACE_JSONL;
  process.env.PI_TEAMS_TRACE_JSONL = environment.traceFile;
  const intentRecords: IntentRecord[] = [];
  const phaseTrace: Record<string, TraceRecord[]> = {};
  const taskIds: string[][] = [[], [], [], []];
  let active = 0;
  let peakOutstandingIntents = 0;
  const started = performance.now();

  try {
    async function intent<T>(lane: number, verb: string, action: () => Promise<T>): Promise<T> {
      const intentStart = performance.now();
      active += 1;
      peakOutstandingIntents = Math.max(peakOutstandingIntents, active);
      let outcome: "ok" | "error" = "ok";
      try {
        return await action();
      } catch (error) {
        outcome = "error";
        throw error;
      } finally {
        active -= 1;
        intentRecords.push({ lane, verb, durationMs: performance.now() - intentStart, outcome });
      }
    }

    async function phase(verb: string, countPerLane: number, action: (lane: number, index: number) => Promise<unknown>): Promise<void> {
      const before = readTrace(environment.traceFile).length;
      await Promise.all([0, 1, 2, 3].map(async (lane) => {
        for (let index = 0; index < countPerLane; index++) await intent(lane, verb, () => action(lane, index));
      }));
      phaseTrace[verb] = readTrace(environment.traceFile).slice(before);
    }

    await phase("create", 5, async (lane, index) => {
      const task = await tasks.createTask(
        teamName,
        {
          title: `Benchmark task ${lane}-${index}`,
          description: "Synthetic benchmark payload",
        },
        environment.laneBindings[lane],
      );
      taskIds[lane].push(task.id);
      return task;
    });
    await phase("read", 25, (lane, index) => tasks.readTask(teamName, taskIds[lane][index % 5]));
    await phase("list", 25, () => tasks.listTasks(teamName));
    await phase("status_update", 25, (lane, index) => tasks.applySemanticTaskUpdate(
      teamName,
      taskIds[lane][index % 5],
      { status: index % 2 === 0 ? "in_progress" : "open" },
      environment.laneBindings[lane],
    ));
    await phase("assignee_status_update", 20, (lane, index) => tasks.applySemanticTaskUpdate(
      teamName,
      taskIds[lane][index % 5],
      { assignee: `worker-${lane}`, status: "in_progress" },
      environment.laneBindings[lane],
    ));
    await phase("design_update", 12, (lane, index) => tasks.applySemanticTaskUpdate(
      teamName,
      taskIds[lane][index % 5],
      { design: `design-${lane}-${index}` },
      environment.laneBindings[lane],
    ));
    await phase("append_note", 13, (lane, index) => tasks.applySemanticTaskUpdate(
      teamName,
      taskIds[lane][index % 5],
      { appendNote: `note-${lane}-${index}` },
      environment.laneBindings[lane],
    ));

    const traces = readTrace(environment.traceFile);
    if (intentRecords.length !== 500 || traces.length !== 500) {
      throw new Error(`Expected exactly 500 agent intents/traces, observed ${intentRecords.length}/${traces.length}.`);
    }
    const wallMs = performance.now() - started;
    const allBdCalls = traces.flatMap((trace) => trace.bdCalls);
    const byVerb = Object.fromEntries(Object.entries(phaseTrace).map(([verb, phase]) => {
      const intents = intentRecords.filter((record) => record.verb === verb);
      return [verb, {
        intents: intents.length,
        latency: stats(intents.map((record) => record.durationMs)),
        bdCalls: phase.reduce((sum, trace) => sum + trace.bdCallCount, 0),
        bdCallsPerIntent: phase.reduce((sum, trace) => sum + trace.bdCallCount, 0) / intents.length,
        lockWaitMs: phase.reduce((sum, trace) => sum + trace.lockWaitMs, 0),
      }];
    }));
    const commandCounts = Object.fromEntries([...new Set(allBdCalls.map((call) => call.command))].sort().map((command) => [
      command,
      allBdCalls.filter((call) => call.command === command).length,
    ]));
    const spoolRecords = [0, 1, 2, 3].flatMap((lane) => {
      const file = paths.taskDeliveryPath(teamName, `worker-${lane}`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    });
    const assigneeOutboxFile = paths.taskOwnerTransitionOutboxPath(teamName);
    const assigneeOutboxRecords: Array<{
      state?: string;
      targets?: unknown[];
      resolvedTargetKeys?: string[];
    }> = fs.existsSync(assigneeOutboxFile)
      ? JSON.parse(fs.readFileSync(assigneeOutboxFile, "utf8"))
      : [];
    const assigneeOutboxTargets = assigneeOutboxRecords.reduce((sum, record) => sum + (record.targets?.length || 0), 0);
    const assigneeOutboxResolvedTargets = assigneeOutboxRecords.reduce((sum, record) => sum + (record.resolvedTargetKeys?.length || 0), 0);
    return {
      schemaVersion: 2,
      capturedAt: new Date().toISOString(),
      boundary: "agent-facing Task functions",
      mode,
      semanticIntents: 500,
      traceRecords: traces.length,
      wallMs,
      peakOutstandingIntents,
      errors: intentRecords.filter((record) => record.outcome === "error").length,
      modelExecution: {
        completions: 0,
        turns: 0,
        tokens: 0,
        measured: false,
        note: "This benchmark measures PiTeams plus Beads mechanics only; use a live Session trace for model-turn cost.",
      },
      workload: {
        lanes: environment.laneBindings.map((binding, lane) => ({
          lane,
          actor: binding.actor,
          sessionFilePresent: !!binding.actingSessionFile,
          membershipIdPresent: !!binding.actingMembershipId,
          mutationIntents: intentRecords.filter((record) => record.lane === lane && !["read", "list"].includes(record.verb)).length,
          readOnlyIntents: intentRecords.filter((record) => record.lane === lane && ["read", "list"].includes(record.verb)).length,
        })),
        mutationAuthority: "exact per-lane Membership + Session",
      },
      intentLatency: stats(intentRecords.map((record) => record.durationMs)),
      bd: {
        version: execFileSync("bd", ["--version"], { encoding: "utf8" }).trim(),
        invocations: allBdCalls.length,
        invocationsPerIntent: allBdCalls.length / 500,
        totalInvocationMs: allBdCalls.reduce((sum, call) => sum + call.durationMs, 0),
        invocationLatency: stats(allBdCalls.map((call) => call.durationMs)),
        commandCounts,
        errors: allBdCalls.filter((call) => call.outcome !== "ok").length,
      },
      byVerb,
      deliveryMetrics: {
        deliveryRecords: spoolRecords.length,
        uniqueDeliveryIds: new Set(spoolRecords.map((record: any) => record.deliveryId)).size,
        measuredScope: "persisted Task delivery spool only; steer, echo, reconciliation, and prune behavior not instrumented",
      },
      assigneeTransitionOutboxMetrics: {
        retainedIntents: assigneeOutboxRecords.length,
        preparedIntents: assigneeOutboxRecords.filter((record) => record.state === "prepared").length,
        committedIntents: assigneeOutboxRecords.filter((record) => record.state === "committed").length,
        abandonedIntents: assigneeOutboxRecords.filter((record) => record.state === "abandoned").length,
        targets: assigneeOutboxTargets,
        resolvedTargets: assigneeOutboxResolvedTargets,
        unresolvedTargets: assigneeOutboxTargets - assigneeOutboxResolvedTargets,
        measuredScope: "retained authority-linked assignee-transition outbox records after the 500-intent workload",
      },
      privacy: {
        workspacePathIncluded: false,
        taskPayloadIncluded: false,
        userIdentityIncluded: false,
      },
    };
  } finally {
    if (previousTrace === undefined) delete process.env.PI_TEAMS_TRACE_JSONL;
    else process.env.PI_TEAMS_TRACE_JSONL = previousTrace;
    environment.server?.kill("SIGTERM");
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
    fs.rmSync(environment.root, { recursive: true, force: true });
  }
}

const modeArg = process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1] || "server";
const outputArg = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
if (modeArg !== "embedded" && modeArg !== "server") throw new Error(`Unsupported mode: ${modeArg}`);
run(modeArg).then((summary) => {
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  if (outputArg) {
    const output = path.resolve(outputArg);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serialized);
    process.stdout.write(`${JSON.stringify({ output, semanticIntents: summary.semanticIntents, wallMs: summary.wallMs, errors: summary.errors })}\n`);
  } else {
    process.stdout.write(serialized);
  }
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
