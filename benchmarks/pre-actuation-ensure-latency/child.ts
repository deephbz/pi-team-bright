import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

type Condition = "isolated" | "loaded" | "directory_loaded";

type Trace = {
  worker_index: number;
  status: "complete" | "error";
  error_kind?: string;
  phase_order: string[];
  phases_ms: Record<string, number>;
  ensure_to_membership_prepared_ms?: number;
  bridge_to_membership_prepared_ms?: number;
  lock_wait_total_ms?: number;
  post_prepared_to_launch_boundary_ms?: number;
  boundary?: {
    prepared_membership_current: boolean;
    pending_launch_present: boolean;
    session_absent: boolean;
    prepared_event_matches: boolean;
    spawn_calls_total: number;
    task_reconciliation_calls_before_boundary: number;
    agent_session_files: number;
    resource_aggregate_materialized: boolean;
    resource_aggregate_removed: boolean;
    cwd_matches_request: boolean;
    model_matches_resolved_setting: boolean;
    trusted_project_matches_request: boolean;
  };
  aggregate_paths: string[];
  app_started_at?: number;
  bridge_started_at?: number;
  membership_prepared_at?: number;
  launch_boundary_at?: number;
  bridge_active?: boolean;
  resource_projection_trusted?: boolean;
  model_resolution_succeeded?: boolean;
};

type ChildResult = {
  schema: "pi-team-bright/pre-actuation-ensure-child/1";
  status: "complete" | "partial" | "error";
  condition: Condition;
  worker_count: number;
  foreign_team_count: number;
  setup_ms: number;
  source_fence: {
    bridge_sha256: string;
    application_sha256: string;
    ordering_verified: boolean;
  };
  traces: Trace[];
  reconciliation: {
    calls_total: number;
    calls_before_boundary: number;
    beads_calls_before_boundary: number;
    conclusion: "not_reached_before_pre_actuation_boundary" | "unexpected_call";
  };
};

const traceStore = new AsyncLocalStorage<Trace>();
const QUALIFIED_MODEL = "benchmark/model";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function integer(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer.`);
  return parsed;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function errorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return "Error";
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function phase(trace: Trace, name: string): void {
  trace.phase_order.push(name);
}

function timeSync<T>(trace: Trace | undefined, name: string, action: () => T): T {
  if (!trace) return action();
  phase(trace, name);
  const started = performance.now();
  try {
    return action();
  } finally {
    trace.phases_ms[name] = rounded(performance.now() - started);
  }
}

async function timeAsync<T>(trace: Trace | undefined, name: string, action: () => Promise<T>): Promise<T> {
  if (!trace) return action();
  phase(trace, name);
  const started = performance.now();
  try {
    return await action();
  } finally {
    trace.phases_ms[name] = rounded(performance.now() - started);
  }
}

function countFiles(directory: string): number {
  let count = 0;
  const visit = (candidate: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(candidate, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(candidate, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) count += 1;
    }
  };
  visit(directory);
  return count;
}

function sourceFence(repository: string) {
  const bridge = path.join(repository, "src/team-authority/worker-launch-bridge.ts");
  const application = path.join(repository, "src/model-tool-contract/durable-model-tool-team-application.ts");
  const bridgeSource = fs.readFileSync(bridge, "utf8");
  const applicationSource = fs.readFileSync(application, "utf8");
  const addMember = bridgeSource.indexOf("await teams.addMember");
  const prepared = bridgeSource.indexOf("this.dependencies.lifecyclePublication.recordWorkerPrepared", addMember);
  const launch = bridgeSource.indexOf("this.launchPreparedMembership", prepared);
  const logical = applicationSource.indexOf("await teams.ensureLogicalWorker");
  const bridgeCall = applicationSource.indexOf("await this.launchBridge.ensureWorker");
  const reconcile = applicationSource.indexOf("await this.taskOrchestration?.reconcileReady");
  return {
    bridge_sha256: sha256(bridge),
    application_sha256: sha256(application),
    ordering_verified: addMember >= 0 && prepared > addMember && launch > prepared
      && logical >= 0 && bridgeCall > logical && reconcile > bridgeCall,
  };
}

class PreActuationBoundary extends Error {
  constructor() {
    super("pre-actuation benchmark boundary");
    this.name = "PreActuationBoundary";
  }
}

async function main(): Promise<ChildResult> {
  const repository = requiredEnv("PTB_BENCH_REPOSITORY");
  const project = requiredEnv("PTB_BENCH_PROJECT");
  const agentDir = requiredEnv("PI_CODING_AGENT_DIR");
  const condition = option("--condition") as Condition;
  if (condition !== "isolated" && condition !== "loaded" && condition !== "directory_loaded") {
    throw new Error("--condition must be isolated, loaded, or directory_loaded.");
  }
  const configuredModel = QUALIFIED_MODEL;
  const workerCount = integer(option("--workers"), "--workers");
  const foreignTeamCount = integer(option("--foreign-teams"), "--foreign-teams");
  if (workerCount < 1) throw new Error("--workers must be at least one.");

  const setupStarted = performance.now();
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true, mode: 0o700 });
  const appendGlobal = path.join(agentDir, "benchmark-worker-append.md");
  fs.writeFileSync(appendGlobal, "benchmark worker resource\n", { mode: 0o600 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    pi_team_bright: {
      worker: {
        default_model: configuredModel,
        agents: { append_global: appendGlobal },
      },
    },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(project, "AGENTS.md"), "Benchmark-only project instructions.\n", { mode: 0o600 });
  fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({
    pi_team_bright: { worker: { tools: { enable: [], disable: [] } } },
  }), { mode: 0o600 });
  process.chdir(project);
  process.env.PI_TEAMS_TRACE_JSONL = path.join(project, "semantic-trace.jsonl");

  // Load actual source modules only after HOME and the isolated agent directory
  // are in place. Bun module mocks replace only future imports, so setup uses
  // the unwrapped modules and the application/bridge load after the wrappers.
  const sourceUrl = (relative: string) => pathToFileURL(path.join(repository, relative)).href;
  const teams: any = await import(sourceUrl("src/utils/teams.ts"));
  const terminalRegistry: any = await import(sourceUrl("src/adapters/terminal-registry.ts"));
  const teamTerminal: any = await import(sourceUrl("src/utils/team-terminal.ts"));
  const resources: any = await import(sourceUrl("src/utils/worker-resource-projection.ts"));
  const { mock }: any = await import("bun:test");

  let spawnCalls = 0;
  const terminal = {
    name: "benchmark-terminal",
    isDirectCarrier: () => true,
    detect: () => true,
    spawn: () => {
      spawnCalls += 1;
      return "unexpected-spawn";
    },
    kill: () => {},
    isAlive: () => false,
    setTitle: () => {},
    supportsWindows: () => false,
    spawnWindow: () => {
      spawnCalls += 1;
      return "unexpected-window";
    },
    setWindowTitle: () => {},
    killWindow: () => {},
    isWindowAlive: () => false,
  };
  terminalRegistry.setAdapter(terminal);

  const teamName = "preactuation";
  const leadSession = path.join(project, "leader.jsonl");
  const terminalBinding = {
    backend: terminal.name,
    leadTarget: { backend: terminal.name, kind: "pane", targetId: "benchmark-leader" },
  };
  await teams.createTeam(teamName, leadSession, "benchmark-lead", "benchmark", undefined, false,
    undefined, undefined, undefined, undefined, terminalBinding);
  for (let index = 0; index < foreignTeamCount; index += 1) {
    await teams.createTeam(`foreign_${index}`, path.join(project, `foreign-${index}.jsonl`), "benchmark-lead", "benchmark", undefined, false,
      undefined, undefined, undefined, undefined, terminalBinding);
  }

  const originals = {
    teamExists: teams.teamExists,
    readConfig: teams.readConfig,
    ensureLogicalWorker: teams.ensureLogicalWorker,
    addMember: teams.addMember,
    currentTerminalForTeam: teamTerminal.currentTerminalForTeam,
    resolveWorkerLaunchResources: resources.resolveWorkerLaunchResources,
    resolveQualifiedWorkerDefaultModel: resources.resolveQualifiedWorkerDefaultModel,
  };

  mock.module(sourceUrl("src/utils/teams.ts"), () => ({
    ...teams,
    teamExists: (name: string) => {
      const trace = traceStore.getStore();
      return trace?.bridge_active
        ? timeSync(trace, "bridge_team_exists", () => originals.teamExists(name))
        : originals.teamExists(name);
    },
    readConfig: async (name: string) => {
      const trace = traceStore.getStore();
      return trace?.bridge_active
        ? timeAsync(trace, "bridge_team_config_read", () => originals.readConfig(name))
        : originals.readConfig(name);
    },
    ensureLogicalWorker: async (name: string, input: unknown) => timeAsync(
      traceStore.getStore(),
      "logical_worker_persistence",
      () => originals.ensureLogicalWorker(name, input),
    ),
    addMember: async (name: string, member: unknown) => timeAsync(
      traceStore.getStore(),
      "membership_persistence",
      () => originals.addMember(name, member),
    ),
  }));
  mock.module(sourceUrl("src/utils/team-terminal.ts"), () => ({
    ...teamTerminal,
    currentTerminalForTeam: (config: unknown) => timeSync(
      traceStore.getStore(),
      "terminal_detection",
      () => originals.currentTerminalForTeam(config),
    ),
  }));
  mock.module(sourceUrl("src/utils/worker-resource-projection.ts"), () => ({
    ...resources,
    resolveWorkerLaunchResources: (input: unknown) => timeSync(
      traceStore.getStore(),
      "worker_resource_aggregate_projection",
      () => {
        const result = originals.resolveWorkerLaunchResources(input);
        const trace = traceStore.getStore();
        if (trace) {
          if (result.aggregatePath) trace.aggregate_paths.push(result.aggregatePath);
          trace.resource_projection_trusted = result.projectTrusted;
        }
        return result;
      },
    ),
  }));

  // These modules load after the mock seams above.
  const { DurableTeamLifecyclePublication }: any = await import(sourceUrl("src/adapters/durable-team-lifecycle-publication.ts"));
  const { withSemanticTrace }: any = await import(sourceUrl("src/utils/trace.ts"));
  const eventJournal: any = await import(sourceUrl("src/coordination/event-journal.ts"));
  const { WorkerLaunchBridge }: any = await import(sourceUrl("src/team-authority/worker-launch-bridge.ts"));
  const { DurableModelToolBindings }: any = await import(sourceUrl("src/model-tool-contract/durable-model-tool-bindings.ts"));
  const { DurableModelToolTeamApplication }: any = await import(sourceUrl("src/model-tool-contract/durable-model-tool-team-application.ts"));
  const { exactLeaderSessionId }: any = await import(sourceUrl("src/model-tool-contract/model-tool-contracts.ts"));

  class BoundaryBridge extends WorkerLaunchBridge {
    async ensureWorker(request: unknown): Promise<unknown> {
      const trace = traceStore.getStore();
      if (trace) {
        trace.bridge_started_at = performance.now();
        trace.bridge_active = true;
        phase(trace, "bridge_entered");
      }
      try {
        return await super.ensureWorker(request as any);
      } finally {
        if (trace) trace.bridge_active = false;
      }
    }

    async launchPreparedMembership(): Promise<never> {
      const trace = traceStore.getStore();
      if (trace) {
        trace.launch_boundary_at = performance.now();
        phase(trace, "launch_prepared_membership_boundary");
      }
      throw new PreActuationBoundary();
    }
  }

  const durablePublication = new DurableTeamLifecyclePublication();
  const lifecyclePublication = {
    readEventCursor: (...args: any[]) => durablePublication.readEventCursor(...args),
    recordWorkerPrepared: async (input: any) => {
      const trace = traceStore.getStore();
      return timeAsync(trace, "prepared_event_publication", async () => {
        const value = await durablePublication.recordWorkerPrepared(input);
        if (trace) trace.membership_prepared_at = performance.now();
        return value;
      });
    },
    recordWorkerStopped: (...args: any[]) => durablePublication.recordWorkerStopped(...args),
    recordWorkerSessionBound: (...args: any[]) => durablePublication.recordWorkerSessionBound(...args),
    recordWorkerFailed: (...args: any[]) => durablePublication.recordWorkerFailed(...args),
    observeWorkerStartup: (...args: any[]) => durablePublication.observeWorkerStartup(...args),
  };

  let reconciliationCalls = 0;
  let reconciliationCallsBeforeBoundary = 0;
  const taskOrchestration = {
    reconcileReady: async () => {
      reconciliationCalls += 1;
      const trace = traceStore.getStore();
      if (!trace?.membership_prepared_at) reconciliationCallsBeforeBoundary += 1;
      return [];
    },
  };

  const bridge = new BoundaryBridge({
    buildWorkerArgv: () => ["pi"],
    resolveModel: () => null,
    resolveSettingsModel: (model: string) => timeSync(traceStore.getStore(), "model_resolution", () => {
      const resolved = model === QUALIFIED_MODEL ? model : null;
      const trace = traceStore.getStore();
      if (trace) trace.model_resolution_succeeded = resolved === model;
      return resolved;
    }),
    workerAggregate: () => ({ projectTrusted: true }),
    lifecyclePublication,
  });
  const bindings = new DurableModelToolBindings();
  const leaderId = exactLeaderSessionId("benchmark-leader");
  bindings.setLeaderSessionFile(leaderId, leadSession);
  bindings.setLeaderLaunchContext(leaderId, { cwd: project, projectTrusted: true });
  const originalBoundTeam = bindings.boundTeam.bind(bindings);
  bindings.boundTeam = async (id: unknown) => timeAsync(
    traceStore.getStore(),
    "leader_binding_and_config",
    () => originalBoundTeam(id),
  );
  const application = new DurableModelToolTeamApplication(bindings, bridge, undefined, undefined, taskOrchestration);

  const traces: Trace[] = Array.from({ length: workerCount }, (_, workerIndex) => ({
    worker_index: workerIndex,
    status: "complete",
    phase_order: [],
    phases_ms: {},
    aggregate_paths: [],
  }));

  await Promise.all(traces.map(async (trace) => {
    const operation = `pre-actuation-${trace.worker_index}`;
    try {
      const result = await withSemanticTrace(operation, { teamName }, () => traceStore.run(trace, async () => {
        trace.app_started_at = performance.now();
        phase(trace, "ensure_started");
        return application.ensureWorker(leaderId, {
          name: `worker_${trace.worker_index}`,
          scope: "Measure one pre-actuation ensure path.",
        });
      }));
      if (!result || result.kind !== "unavailable" || result.reason !== "carrier_unavailable") {
        throw new Error("The pre-actuation boundary did not return the expected unavailable result.");
      }
    } catch (error) {
      trace.status = "error";
      trace.error_kind = errorKind(error);
    }
  }));

  const semanticRecords = new Map<string, any>();
  try {
    for (const line of fs.readFileSync(process.env.PI_TEAMS_TRACE_JSONL!, "utf8").split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (typeof record.operation === "string") semanticRecords.set(record.operation, record);
    }
  } catch {
    // A missing trace is a failed validation below, not a durable runtime write.
  }

  for (const trace of traces) {
    const worker = `worker_${trace.worker_index}`;
    const record = semanticRecords.get(`pre-actuation-${trace.worker_index}`);
    trace.lock_wait_total_ms = typeof record?.lockWaitMs === "number" ? rounded(record.lockWaitMs) : undefined;
    if (trace.status !== "complete" || !trace.app_started_at || !trace.membership_prepared_at || !trace.bridge_started_at || !trace.launch_boundary_at) {
      trace.status = "error";
      trace.error_kind ||= trace.model_resolution_succeeded === false ? "ModelResolverRejected" : "BoundaryTraceIncomplete";
      continue;
    }
    trace.ensure_to_membership_prepared_ms = rounded(trace.membership_prepared_at - trace.app_started_at);
    trace.bridge_to_membership_prepared_ms = rounded(trace.membership_prepared_at - trace.bridge_started_at);
    trace.post_prepared_to_launch_boundary_ms = rounded(trace.launch_boundary_at - trace.membership_prepared_at);
    const member = await originals.readConfig(teamName).then((config: any) => config.members.find((candidate: any) => candidate.name === worker && candidate.isActive !== false));
    const workerEvents = eventJournal.readTeamEvents(teamName, { eventTypes: ["worker"] }).events;
    const preparedEvent = workerEvents.find((event: any) => event.worker === worker && event.phase === "prepared" && event.membershipId === member?.membershipId);
    let removed = true;
    for (const aggregatePath of trace.aggregate_paths) {
      resources.removeWorkerAggregate(aggregatePath);
      if (fs.existsSync(aggregatePath)) removed = false;
    }
    trace.boundary = {
      prepared_membership_current: !!member,
      pending_launch_present: !!member?.pendingLaunchId,
      session_absent: !member?.sessionFile,
      prepared_event_matches: !!preparedEvent,
      spawn_calls_total: spawnCalls,
      task_reconciliation_calls_before_boundary: reconciliationCallsBeforeBoundary,
      agent_session_files: countFiles(path.join(agentDir, "sessions")),
      resource_aggregate_materialized: trace.aggregate_paths.length === 1,
      resource_aggregate_removed: removed,
      cwd_matches_request: member?.cwd === project,
      model_matches_resolved_setting: member?.model === configuredModel,
      trusted_project_matches_request: trace.resource_projection_trusted === true,
    };
    const values = Object.values(trace.boundary);
    if (values.some((value) => value === false) || trace.boundary.spawn_calls_total !== 0
      || trace.boundary.task_reconciliation_calls_before_boundary !== 0
      || trace.boundary.agent_session_files !== 0) {
      trace.status = "error";
      trace.error_kind = "BoundaryValidationFailed";
    }
    const bridgePhaseNames = [
      "bridge_team_exists",
      "bridge_team_config_read",
      "terminal_detection",
      "worker_resource_aggregate_projection",
      "model_resolution",
      "membership_persistence",
      "prepared_event_publication",
    ];
    const bridgeMeasured = bridgePhaseNames.reduce((sum, name) => sum + (trace.phases_ms[name] ?? 0), 0);
    trace.phases_ms.bridge_team_config_and_terminal_detection = rounded(
      (trace.phases_ms.bridge_team_exists ?? 0)
      + (trace.phases_ms.bridge_team_config_read ?? 0)
      + (trace.phases_ms.terminal_detection ?? 0),
    );
    trace.phases_ms.unattributed_bridge_overhead = rounded(Math.max(0,
      (trace.bridge_to_membership_prepared_ms ?? 0) - bridgeMeasured,
    ));
    trace.phases_ms.unattributed_application_overhead = rounded(Math.max(0,
      (trace.ensure_to_membership_prepared_ms ?? 0)
      - (trace.phases_ms.leader_binding_and_config ?? 0)
      - (trace.phases_ms.logical_worker_persistence ?? 0)
      - (trace.bridge_to_membership_prepared_ms ?? 0),
    ));
  }

  const setupMs = rounded(performance.now() - setupStarted);
  return {
    schema: "pi-team-bright/pre-actuation-ensure-child/1",
    status: traces.every((trace) => trace.status === "complete") ? "complete" : "partial",
    condition,
    worker_count: workerCount,
    foreign_team_count: foreignTeamCount,
    setup_ms: setupMs,
    source_fence: sourceFence(repository),
    traces: traces.map((trace) => ({ ...trace, aggregate_paths: [] })),
    reconciliation: {
      calls_total: reconciliationCalls,
      calls_before_boundary: reconciliationCallsBeforeBoundary,
      beads_calls_before_boundary: 0,
      conclusion: reconciliationCalls === 0 && reconciliationCallsBeforeBoundary === 0
        ? "not_reached_before_pre_actuation_boundary"
        : "unexpected_call",
    },
  };
}

void main().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch((error) => {
  if (process.env.PTB_BENCH_DEBUG === "1") {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
  const fallback: ChildResult = {
    schema: "pi-team-bright/pre-actuation-ensure-child/1",
    status: "error",
    condition: (option("--condition") as Condition) || "isolated",
    worker_count: 0,
    foreign_team_count: 0,
    setup_ms: 0,
    source_fence: { bridge_sha256: "", application_sha256: "", ordering_verified: false },
    traces: [{ worker_index: 0, status: "error", error_kind: errorKind(error), phase_order: [], phases_ms: {}, aggregate_paths: [] }],
    reconciliation: { calls_total: 0, calls_before_boundary: 0, beads_calls_before_boundary: 0, conclusion: "unexpected_call" },
  };
  process.stdout.write(`${JSON.stringify(fallback)}\n`);
  process.exitCode = 1;
});
