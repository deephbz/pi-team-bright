import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import piTeams from "../extensions/index";
import { clearAdapterCache, setAdapter } from "../src/adapters/terminal-registry";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";

const outputFile = process.env.PI_TEAMS_ENSURE_WORKER_BENCHMARK_OUTPUT;
const samples = Number(process.env.PI_TEAMS_ENSURE_WORKER_BENCHMARK_SAMPLES ?? "5");

type Sample = { wallClockMs: number; semanticTraceMs: number };

function summarize(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)]!;
  return {
    samples: sorted.length,
    min_ms: Number(sorted[0]!.toFixed(4)),
    p50_ms: Number(at(0.5).toFixed(4)),
    p95_ms: Number(at(0.95).toFixed(4)),
    max_ms: Number(sorted.at(-1)!.toFixed(4)),
    samples_ms: samples.map((sample) => Number(sample.toFixed(4))),
  };
}

function records(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const benchmark = outputFile ? test : test.skip;

benchmark("records ensure_worker created and reused tool timing", async () => {
  if (!path.isAbsolute(outputFile!)) throw new Error("PI_TEAMS_ENSURE_WORKER_BENCHMARK_OUTPUT must be absolute.");
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100) {
    throw new Error("PI_TEAMS_ENSURE_WORKER_BENCHMARK_SAMPLES must be an integer from 1 through 100.");
  }
  const teamName = `ensure-worker-benchmark-${process.pid}-${Date.now()}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-ensure-worker-benchmark-"));
  const traceFile = path.join(root, "trace.jsonl");
  const project = path.join(root, "project");
  const previousMembership = process.env.PI_TEAM_MEMBERSHIP_ID;
  const previousTrace = process.env.PI_TEAMS_TRACE_JSONL;
  const previousWait = process.env.PI_TEAMS_WORKER_STARTUP_WAIT_MS;
  const previousAgent = process.env.PI_AGENT_NAME;
  const previousTeam = process.env.PI_TEAM_NAME;
  const previousLaunch = process.env.PI_AGENT_LAUNCH_ID;
  const liveTargets = new Set<string>();
  const bindings = new Map<string, Promise<unknown>>();

  try {
    fs.mkdirSync(project, { recursive: true });
    delete process.env.PI_TEAM_MEMBERSHIP_ID;
    delete process.env.PI_TEAM_NAME;
    delete process.env.PI_AGENT_LAUNCH_ID;
    process.env.PI_AGENT_NAME = "";
    process.env.PI_TEAMS_TRACE_JSONL = traceFile;
    process.env.PI_TEAMS_WORKER_STARTUP_WAIT_MS = "0";
    setAdapter({
      name: "ensure-worker-benchmark-terminal",
      detect: () => true,
      isDirectCarrier: () => true,
      currentTargetId: () => "leader-pane",
      spawn: (options: { name: string }) => {
        const targetId = `pane-${options.name}`;
        liveTargets.add(targetId);
        bindings.set(options.name, (async () => {
          const prepared = await teams.currentMembership(teamName, options.name);
          await teams.bindMemberSession(
            teamName,
            options.name,
            path.join(project, `${options.name}.jsonl`),
            prepared.pendingLaunchId,
            {},
            prepared.membershipId,
          );
        })());
        return targetId;
      },
      kill: (targetId: string) => { liveTargets.delete(targetId); },
      isAlive: (targetId: string) => liveTargets.has(targetId),
      setTitle() {},
      supportsWindows: () => false,
      spawnWindow: () => { throw new Error("Separate windows are outside this benchmark."); },
      setWindowTitle() {},
      killWindow() {},
      isWindowAlive: () => false,
    });
    const tools = new Map<string, any>();
    piTeams({
      registerTool(tool: any) { tools.set(tool.name, tool); },
      on() {},
      sendMessage() {},
      sendUserMessage() {},
      getThinkingLevel: () => "medium",
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools() {},
    } as never);
    const leaderSession = path.join(project, "leader.jsonl");
    await teams.createTeam(
      teamName,
      leaderSession,
      "benchmark-lead",
      "Measure ensure_worker tool execution.",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { backend: "ensure-worker-benchmark-terminal", leadTarget: { backend: "ensure-worker-benchmark-terminal", kind: "pane", targetId: "leader-pane" } },
    );
    const ensure = tools.get("ensure_worker");
    if (!ensure) throw new Error("ensure_worker was not registered.");
    const context = {
      cwd: project,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => `benchmark-session-${teamName}`,
        getSessionFile: () => leaderSession,
      },
    };
    const measure = async (worker: string): Promise<Sample> => {
      const before = records(traceFile).length;
      const startedAt = performance.now();
      const result = await ensure.execute(`ensure-${worker}`, {
        name: worker,
        scope: "Measure model-tool Worker topology execution.",
      }, undefined, undefined, context);
      expect(result.details).toMatchObject({ kind: "worker_ensured", worker: { name: worker } });
      const trace = records(traceFile).slice(before).reverse()
        .find((record) => record.operation === "ensure_worker");
      if (!trace || typeof trace.durationMs !== "number") throw new Error("ensure_worker did not emit its semantic trace.");
      return { wallClockMs: performance.now() - startedAt, semanticTraceMs: trace.durationMs };
    };

    const created: Sample[] = [];
    const reused: Sample[] = [];
    for (let index = 0; index < samples; index += 1) {
      const worker = `worker-${index + 1}`;
      created.push(await measure(worker));
      const binding = bindings.get(worker);
      if (!binding) throw new Error(`Synthetic carrier did not prepare ${worker}.`);
      await binding;
      reused.push(await measure(worker));
    }
    const traces = records(traceFile);
    const taskAuthorityOperations = traces
      .map((trace) => trace.operation)
      .filter((operation): operation is string => typeof operation === "string" && operation.startsWith("task_"));
    expect(taskAuthorityOperations).toEqual([]);
    expect(traces.filter((trace) => trace.operation === "ensure_worker")).toHaveLength(samples * 2);

    fs.mkdirSync(path.dirname(outputFile!), { recursive: true });
    fs.writeFileSync(outputFile!, `${JSON.stringify({
      schema: "pi-team-bright/ensure-worker-tool-benchmark/1",
      recorded_at: new Date().toISOString(),
      environment: { node_version: process.version, platform: process.platform },
      workload: {
        samples_per_case: samples,
        setup: "One isolated Team, one synthetic direct terminal carrier, and one exact Session binding before each reuse.",
        measured_boundary: "Pi ensure_worker tool execute through model-tool registration, exact leader binding, logical Worker topology, Worker launch bridge, and result projection.",
      },
      measurements: {
        created_tool_execute_wall_clock: summarize(created.map((sample) => sample.wallClockMs)),
        created_tool_semantic_trace: summarize(created.map((sample) => sample.semanticTraceMs)),
        reused_tool_execute_wall_clock: summarize(reused.map((sample) => sample.wallClockMs)),
        reused_tool_semantic_trace: summarize(reused.map((sample) => sample.semanticTraceMs)),
      },
      trace_evidence: {
        ensure_worker_records: traces.filter((trace) => trace.operation === "ensure_worker").length,
        task_authority_operations: taskAuthorityOperations,
      },
      limits: [
        "The terminal carrier is synthetic and the Worker Session binding is simulated; this does not measure Pi child-process startup or model/message time.",
        "team_create is excluded. The trace records only model-tool execution time, unlike Pi Session assistant-to-toolResult timestamps.",
        "The benchmark proves the post-change tool path emits no Task-authority semantic operation. The production pre-change task_list cost must be measured from a matching live Task authority.",
      ],
    }, null, 2)}\n`, { mode: 0o600 });
  } finally {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
    clearAdapterCache();
    if (previousMembership === undefined) delete process.env.PI_TEAM_MEMBERSHIP_ID;
    else process.env.PI_TEAM_MEMBERSHIP_ID = previousMembership;
    if (previousTrace === undefined) delete process.env.PI_TEAMS_TRACE_JSONL;
    else process.env.PI_TEAMS_TRACE_JSONL = previousTrace;
    if (previousWait === undefined) delete process.env.PI_TEAMS_WORKER_STARTUP_WAIT_MS;
    else process.env.PI_TEAMS_WORKER_STARTUP_WAIT_MS = previousWait;
    if (previousAgent === undefined) delete process.env.PI_AGENT_NAME;
    else process.env.PI_AGENT_NAME = previousAgent;
    if (previousTeam === undefined) delete process.env.PI_TEAM_NAME;
    else process.env.PI_TEAM_NAME = previousTeam;
    if (previousLaunch === undefined) delete process.env.PI_AGENT_LAUNCH_ID;
    else process.env.PI_AGENT_LAUNCH_ID = previousLaunch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
