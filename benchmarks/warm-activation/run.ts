import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

const SCHEMA = "pi-team-bright/warm-activation-machine-results/1";
const repositoryRoot = path.resolve(__dirname, "../..");
const probeExtensionPath = path.join(repositoryRoot, "benchmarks/warm-activation/probe-extension.ts");
const preloadedMainChildPath = path.join(repositoryRoot, "benchmarks/warm-activation/reserved-main-child.mjs");
const piCliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const piTeamBrightExtensionPath = path.join(repositoryRoot, "extensions/index.ts");
const defaultArtifactPath = path.join(repositoryRoot, "docs/journal/artifacts/2026-08-14-warm-activation-machine-results.json");
const defaultModel = "openai-codex/gpt-5.6-terra";
const defaultThinking = "medium";
const teamEnvironmentNames = [
  "PI_TEAM_NAME",
  "PI_AGENT_NAME",
  "PI_TEAM_MEMBERSHIP_ID",
  "PI_AGENT_LAUNCH_ID",
  "PI_TEAM_BRIGHT_WORKER_AGGREGATE",
  "PI_TEAM_BRIGHT_MODEL_TOOL",
];

interface Options {
  samples: number;
  model: string;
  pane?: string;
  artifactPath: string;
}

interface Sandbox {
  root: string;
  cwd: string;
  neutralCwd: string;
  home: string;
  agentDir: string;
  sessionDir: string;
  recordPath: string;
}

interface ExitResult {
  code: number | null;
  signal: string | null;
}

interface CommandResult {
  ok: boolean;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

type JsonRecord = Record<string, any>;

function parseOptions(argv: readonly string[]): Options {
  let samples = 7;
  let model = defaultModel;
  let pane: string | undefined;
  let artifactPath = defaultArtifactPath;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--samples") {
      const value = argv[++index];
      if (!value || !/^\d+$/.test(value) || Number(value) < 3) throw new Error("--samples must be an integer of at least 3.");
      samples = Number(value);
    } else if (option === "--model") {
      const value = argv[++index];
      if (!value || !/^[^/\s]+\/[^/\s]+$/.test(value)) throw new Error("--model must have provider/model form.");
      model = value;
    } else if (option === "--pane") {
      const value = argv[++index];
      if (!value) throw new Error("--pane requires an exact source pane ID.");
      pane = value;
    } else if (option === "--artifact") {
      const value = argv[++index];
      if (!value) throw new Error("--artifact requires a path.");
      artifactPath = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${option ?? "<missing>"}.`);
    }
  }
  return { samples, model, pane, artifactPath };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function megabytes(bytes: unknown): number | null {
  return typeof bytes === "number" && Number.isFinite(bytes) ? round(bytes / (1024 * 1024)) : null;
}

function percentile(values: readonly number[], percentage: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)] ?? null;
}

function summarize(samples: readonly ({ latency_ms: number | null; outcome: string } | undefined)[]) {
  const values = samples
    .filter((sample): sample is { latency_ms: number | null; outcome: string } => sample?.outcome === "ok" && typeof sample.latency_ms === "number")
    .map((sample) => sample.latency_ms as number);
  const failures = samples.length - values.length;
  return {
    requested_samples: samples.length,
    successes: values.length,
    failures,
    p50_ms: percentile(values, 50) === null ? null : round(percentile(values, 50)! ),
    p95_ms: percentile(values, 95) === null ? null : round(percentile(values, 95)! ),
    min_ms: values.length ? round(Math.min(...values)) : null,
    max_ms: values.length ? round(Math.max(...values)) : null,
    percentile_method: "nearest-rank successful samples only",
  };
}

function errorCategory(error: unknown): string {
  if (process.env.PTB_WARM_DEBUG === "1" && error instanceof Error) process.stderr.write(`${error.stack ?? error.message}\n`);
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout")) return "timeout";
  if (message.includes("model")) return "model_setup_failed";
  if (message.includes("extension")) return "extension_setup_failed";
  if (message.includes("json")) return "protocol_error";
  if (message.includes("exit")) return "child_exit";
  return error instanceof Error ? error.name : "unknown_error";
}

function setMarker(sandbox: Sandbox, marker: "A" | "B"): void {
  fs.writeFileSync(path.join(sandbox.cwd, "AGENTS.md"), `WARM_ACTIVATION_CONTEXT=${marker}\n`, { encoding: "utf8", mode: 0o600 });
}

function createSandbox(parent: string, label: string): Sandbox {
  const root = fs.mkdtempSync(path.join(parent, `${label}-`));
  const cwd = path.join(root, "project");
  const neutralCwd = path.join(root, "neutral");
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  const recordPath = path.join(root, "probe-records.jsonl");
  for (const directory of [cwd, neutralCwd, home, agentDir, sessionDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  setMarker({ root, cwd, neutralCwd, home, agentDir, sessionDir, recordPath }, "A");
  return { root, cwd, neutralCwd, home, agentDir, sessionDir, recordPath };
}

function cleanChildEnvironment(sandbox: Sandbox, model: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "TERM", "COLORTERM"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  environment.HOME = sandbox.home;
  environment.PI_CODING_AGENT_DIR = sandbox.agentDir;
  environment.PI_CODING_AGENT_SESSION_DIR = sandbox.sessionDir;
  environment.PI_OFFLINE = "1";
  environment.PI_SKIP_VERSION_CHECK = "1";
  environment.WARM_ACTIVATION_RECORD_PATH = sandbox.recordPath;
  environment.WARM_ACTIVATION_EXPECTED_CWD = sandbox.cwd;
  environment.WARM_ACTIVATION_EXPECTED_MODEL = model;
  return environment;
}

function cliArgs(model: string, extensionPaths: readonly string[]): string[] {
  return [
    piCliPath,
    "--mode", "rpc",
    "--offline",
    "--approve",
    "--no-extensions",
    ...extensionPaths.flatMap((extensionPath) => ["-e", extensionPath]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--model", model,
    "--thinking", defaultThinking,
  ];
}

function readProbeRecords(recordPath: string): JsonRecord[] {
  if (!fs.existsSync(recordPath)) return [];
  try {
    return fs.readFileSync(recordPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line) as JsonRecord]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

async function waitForProbe(
  recordPath: string,
  fromIndex: number,
  predicate: (record: JsonRecord) => boolean,
  timeoutMs = 20_000,
): Promise<JsonRecord> {
  const find = () => readProbeRecords(recordPath).slice(fromIndex).find(predicate);
  const existing = find();
  if (existing) return existing;
  return new Promise<JsonRecord>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      action();
    };
    const check = () => {
      const record = find();
      if (record) finish(() => resolve(record));
    };
    const watcher = fs.watch(path.dirname(recordPath), check);
    const timer = setTimeout(() => finish(() => reject(new Error("probe_record_timeout"))), timeoutMs);
    check();
  });
}

function projectProbe(record: JsonRecord | undefined) {
  const environment = record?.team_environment_present && typeof record.team_environment_present === "object"
    ? record.team_environment_present as Record<string, unknown>
    : {};
  return {
    event: typeof record?.event === "string" ? record.event : "missing",
    reason: typeof record?.reason === "string" ? record.reason : undefined,
    cwd_matches_expected: record?.cwd_matches_expected === true,
    context_cwd_matches_expected: record?.context_cwd_matches_expected === true,
    process_cwd_matches_expected: record?.process_cwd_matches_expected === true,
    cwd_comparison: record?.cwd_comparison === "canonical_realpath" ? "canonical_realpath" : "unavailable",
    context_marker: typeof record?.context_marker === "string" ? record.context_marker : "absent",
    model: typeof record?.model === "string" ? record.model : "absent",
    model_matches_expected: record?.model_matches_expected === true,
    session_present: record?.session_present === true,
    team_environment_clear: teamEnvironmentNames.every((name) => environment[name] === false),
    active_tool_count: typeof record?.active_tool_count === "number" ? record.active_tool_count : null,
    has_leader_only_tools: record?.has_leader_only_tools === true,
    active_common_task_tools: typeof record?.active_common_task_tools === "number" ? record.active_common_task_tools : null,
    factory_generation: typeof record?.factory_generation === "number" ? record.factory_generation : null,
    module_command_count: typeof record?.module_command_count === "number" ? record.module_command_count : null,
    closure_command_count: typeof record?.closure_command_count === "number" ? record.closure_command_count : null,
    rss_mb: megabytes(record?.rss_bytes),
  };
}

function moduleRetention(before: JsonRecord | undefined, after: JsonRecord | undefined) {
  return {
    module_instance_retained: typeof before?.module_instance === "string" && before.module_instance === after?.module_instance,
    factory_generation_before: typeof before?.factory_generation === "number" ? before.factory_generation : null,
    factory_generation_after: typeof after?.factory_generation === "number" ? after.factory_generation : null,
  };
}

function projectState(response: JsonRecord | undefined) {
  const data = response?.data ?? {};
  const model = data.model && typeof data.model.provider === "string" && typeof data.model.id === "string"
    ? `${data.model.provider}/${data.model.id}`
    : "absent";
  return {
    session_present: typeof data.sessionId === "string",
    session_file_present: typeof data.sessionFile === "string",
    model,
    thinking_level: typeof data.thinkingLevel === "string" ? data.thinkingLevel : "absent",
  };
}

function stateChanged(previous: JsonRecord | undefined, next: JsonRecord | undefined) {
  const first = previous?.data ?? {};
  const second = next?.data ?? {};
  return {
    session_id_changed: typeof first.sessionId === "string" && typeof second.sessionId === "string" && first.sessionId !== second.sessionId,
    session_file_changed: typeof first.sessionFile === "string" && typeof second.sessionFile === "string" && first.sessionFile !== second.sessionFile,
  };
}

class JsonLineChild {
  readonly child: any;
  private buffer = "";
  private readonly messages: JsonRecord[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly pending = new Map<string, { resolve: (value: JsonRecord) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();
  private exited?: ExitResult;

  constructor(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = childProcess.spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", () => undefined);
    this.child.on("exit", (code: number | null, signal: string | null) => {
      this.exited = { code, signal };
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("child_exit"));
      }
      this.pending.clear();
      this.notify();
    });
    this.child.on("error", () => this.notify());
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line) as JsonRecord;
        this.messages.push(message);
        if (typeof message.id === "string" && message.type === "response") {
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            pending.resolve(message);
          }
        }
        this.notify();
      } catch {
        // Pi can write human timing diagnostics to stdout before RPC takeover.
      }
    }
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  allMessages(): readonly JsonRecord[] {
    return this.messages;
  }

  send(value: JsonRecord): void {
    if (this.exited) throw new Error("child_exit");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  request(command: JsonRecord, timeoutMs = 20_000): Promise<JsonRecord> {
    const id = crypto.randomUUID();
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("rpc_timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...command, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("rpc_send_failed"));
      }
    });
  }

  async waitFor(predicate: (message: JsonRecord) => boolean, timeoutMs = 20_000): Promise<JsonRecord> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return new Promise<JsonRecord>((resolve, reject) => {
      const check = () => {
        const match = this.messages.find(predicate);
        if (match) finish(() => resolve(match));
        else if (this.exited) finish(() => reject(new Error("child_exit")));
      };
      const finish = (action: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        action();
      };
      const timer = setTimeout(() => finish(() => reject(new Error("child_message_timeout"))), timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  endInput(): void {
    if (!this.exited) this.child.stdin.end();
  }

  async waitForExit(timeoutMs = 20_000): Promise<ExitResult> {
    if (this.exited) return this.exited;
    return new Promise<ExitResult>((resolve, reject) => {
      const check = () => {
        if (this.exited) finish(() => resolve(this.exited!));
      };
      const finish = (action: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        action();
      };
      const timer = setTimeout(() => finish(() => reject(new Error("child_exit_timeout"))), timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  async terminate(signal: NodeJS.Signals = "SIGKILL"): Promise<ExitResult> {
    if (!this.exited) this.child.kill(signal);
    return this.waitForExit();
  }
}

async function runCommand(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<CommandResult> {
  const child = childProcess.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise<CommandResult>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, signal, timedOut, stdout, stderr });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, timedOut, stdout, stderr });
    });
  });
}

async function startRpc(sandbox: Sandbox, model: string, extensionPaths: readonly string[]) {
  const started = performance.now();
  const rpc = new JsonLineChild(process.execPath, cliArgs(model, extensionPaths), {
    cwd: sandbox.cwd,
    env: cleanChildEnvironment(sandbox, model),
  });
  const state = await rpc.request({ type: "get_state" }, 30_000);
  const latency = round(performance.now() - started);
  if (state.success !== true) throw new Error("rpc_get_state_failed");
  return { process: rpc, state, latency };
}

async function stopRpc(rpc: JsonLineChild, sandbox: Sandbox, recordsBefore: number) {
  rpc.endInput();
  const exit = await rpc.waitForExit(20_000);
  let shutdown: JsonRecord | undefined;
  try {
    shutdown = await waitForProbe(sandbox.recordPath, recordsBefore, (record) => record.event === "session_shutdown", 2_000);
  } catch {
    shutdown = readProbeRecords(sandbox.recordPath).slice(recordsBefore).find((record) => record.event === "session_shutdown");
  }
  return { exit: { code: exit.code, signal: exit.signal }, shutdown: projectProbe(shutdown) };
}

async function runCancellationProbe(rpc: JsonLineChild) {
  const started = performance.now();
  const bash = rpc.request({
    type: "bash",
    command: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
    excludeFromContext: true,
  }, 10_000).catch((error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const abort = await rpc.request({ type: "abort_bash" }, 5_000);
  const bashResult = await bash;
  return {
    abort_request_acknowledged: abort.success === true,
    completed_after_ms: round(performance.now() - started),
    bash_result_returned: !(bashResult as any).error,
    bash_cancelled: (bashResult as any)?.data?.cancelled === true || (bashResult as any)?.data?.code === null,
  };
}

async function runRpcMechanism(runRoot: string, options: Options) {
  const samples: JsonRecord[] = [];
  let cancellation: JsonRecord | undefined;
  for (let index = 0; index < options.samples; index += 1) {
    const sandbox = createSandbox(runRoot, `rpc-${index + 1}`);
    let process: JsonLineChild | undefined;
    const sample: JsonRecord = { sample: `rpc-${index + 1}` };
    try {
      const recordsBeforeCold = readProbeRecords(sandbox.recordPath).length;
      const cold = await startRpc(sandbox, options.model, [probeExtensionPath]);
      process = cold.process;
      const coldProbe = await waitForProbe(sandbox.recordPath, recordsBeforeCold, (record) => record.event === "session_start" && record.reason === "startup");
      sample.cold = {
        latency_ms: cold.latency,
        outcome: "ok",
        state: projectState(cold.state),
        projection: projectProbe(coldProbe),
      };
      if (index === 0) cancellation = await runCancellationProbe(process);

      setMarker(sandbox, "B");
      const recordsBeforeWarm = readProbeRecords(sandbox.recordPath).length;
      const stateBefore = cold.state;
      const warmStarted = performance.now();
      const warmResponse = await process.request({ type: "new_session" }, 30_000);
      const warmLatency = round(performance.now() - warmStarted);
      const stateAfter = await process.request({ type: "get_state" }, 10_000);
      if (warmResponse.success !== true || stateAfter.success !== true) throw new Error("rpc_new_session_failed");
      const warmProbe = await waitForProbe(sandbox.recordPath, recordsBeforeWarm, (record) => record.event === "session_start" && record.reason === "new");
      sample.warm = {
        latency_ms: warmLatency,
        outcome: "ok",
        replacement: stateChanged(stateBefore, stateAfter),
        state: projectState(stateAfter),
        projection: projectProbe(warmProbe),
        extension_retention: moduleRetention(coldProbe, warmProbe),
        process_retained: typeof coldProbe.process_id === "number" && coldProbe.process_id === warmProbe.process_id,
      };
      const recordsBeforeStop = readProbeRecords(sandbox.recordPath).length;
      sample.shutdown = await stopRpc(process, sandbox, recordsBeforeStop);
      process = undefined;
    } catch (error) {
      const category = errorCategory(error);
      if (!sample.cold) sample.cold = { latency_ms: null, outcome: category };
      else if (!sample.warm) sample.warm = { latency_ms: null, outcome: category };
      else sample.shutdown = { outcome: category };
      if (process) {
        try { await process.terminate(); } catch { /* Child cleanup is best effort after a recorded failure. */ }
      }
    }
    samples.push(sample);
  }

  const crashSandbox = createSandbox(runRoot, "rpc-crash");
  let crashRecovery: JsonRecord;
  try {
    const first = await startRpc(crashSandbox, options.model, [probeExtensionPath]);
    const firstState = first.state;
    const firstPid = first.process.child.pid;
    const killed = await first.process.terminate("SIGKILL");
    const recovered = await startRpc(crashSandbox, options.model, [probeExtensionPath]);
    const recoveredState = recovered.state;
    const recoveryPid = recovered.process.child.pid;
    const recordsBeforeStop = readProbeRecords(crashSandbox.recordPath).length;
    const shutdown = await stopRpc(recovered.process, crashSandbox, recordsBeforeStop);
    crashRecovery = {
      outcome: "ok",
      killed_exit: { code: killed.code, signal: killed.signal },
      recovery_new_process: firstPid !== recoveryPid,
      recovery_new_session: stateChanged(firstState, recoveredState).session_id_changed,
      recovery_shutdown: shutdown,
    };
  } catch (error) {
    crashRecovery = { outcome: errorCategory(error) };
  }

  const unboundSandbox = createSandbox(runRoot, "rpc-unbound-ptb");
  let prebindingToolIsolation: JsonRecord;
  try {
    const recordsBefore = readProbeRecords(unboundSandbox.recordPath).length;
    const unbound = await startRpc(unboundSandbox, options.model, [piTeamBrightExtensionPath, probeExtensionPath]);
    const probe = await waitForProbe(unboundSandbox.recordPath, recordsBefore, (record) => record.event === "session_start" && record.reason === "startup");
    const recordsBeforeStop = readProbeRecords(unboundSandbox.recordPath).length;
    const shutdown = await stopRpc(unbound.process, unboundSandbox, recordsBeforeStop);
    const projection = projectProbe(probe);
    prebindingToolIsolation = {
      outcome: "ok",
      unbound_team_environment_clear: projection.team_environment_clear,
      leader_surface_present: projection.has_leader_only_tools,
      active_common_task_tools: projection.active_common_task_tools,
      interpretation: "The exact Pi Team Bright extension selected the leader surface before any Worker admission. This is not a Worker binding.",
      shutdown,
    };
  } catch (error) {
    prebindingToolIsolation = { outcome: errorCategory(error) };
  }

  return {
    mechanism: "persistent_rpc_session_replacement",
    cold: summarize(samples.map((sample) => sample.cold)),
    warm: summarize(samples.map((sample) => sample.warm)),
    samples,
    cancellation,
    crash_recovery: crashRecovery,
    prebinding_tool_isolation: prebindingToolIsolation,
  };
}

function mutablePiEnvironment(sandbox: Sandbox, model: string): () => void {
  const previous = new Map<string, string | undefined>();
  const relevant = new Set([
    ...Object.keys(process.env).filter((name) => name.startsWith("PI_") || name.startsWith("WARM_ACTIVATION_")),
    "HOME",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "PI_OFFLINE",
    "PI_SKIP_VERSION_CHECK",
    "WARM_ACTIVATION_RECORD_PATH",
    "WARM_ACTIVATION_EXPECTED_CWD",
    "WARM_ACTIVATION_EXPECTED_MODEL",
  ]);
  for (const name of relevant) previous.set(name, process.env[name]);
  for (const name of [...Object.keys(process.env)]) {
    if (name.startsWith("PI_") || name.startsWith("WARM_ACTIVATION_")) delete process.env[name];
  }
  const clean = cleanChildEnvironment(sandbox, model);
  for (const [name, value] of Object.entries(clean)) {
    if (value !== undefined) process.env[name] = value;
  }
  return () => {
    for (const name of relevant) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function runSdkMechanism(runRoot: string, options: Options) {
  const pi: any = await import("@earendil-works/pi-coding-agent");
  const samples: JsonRecord[] = [];
  const [provider, modelId] = options.model.split("/", 2) as [string, string];
  for (let index = 0; index < options.samples; index += 1) {
    const sandbox = createSandbox(runRoot, `sdk-${index + 1}`);
    const restoreEnvironment = mutablePiEnvironment(sandbox, options.model);
    const priorCwd = process.cwd();
    const sample: JsonRecord = { sample: `sdk-${index + 1}` };
    let runtime: any;
    try {
      process.chdir(sandbox.cwd);
      const factory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
        const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
        const services = await pi.createAgentSessionServices({
          cwd,
          agentDir,
          settingsManager,
          resourceLoaderOptions: {
            additionalExtensionPaths: [probeExtensionPath],
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
          },
        });
        const model = services.modelRuntime.getModels()
          .find((candidate: any) => candidate.provider === provider && candidate.id === modelId);
        if (!model) throw new Error("sdk_expected_model_unavailable");
        const created = await pi.createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model,
          thinkingLevel: defaultThinking,
        });
        return { ...created, services, diagnostics: services.diagnostics };
      };
      const sessionManager = pi.SessionManager.create(sandbox.cwd, sandbox.sessionDir);
      const recordsBeforeCold = readProbeRecords(sandbox.recordPath).length;
      const coldStarted = performance.now();
      runtime = await pi.createAgentSessionRuntime(factory, { cwd: sandbox.cwd, agentDir: sandbox.agentDir, sessionManager });
      const bind = async (session: any) => session.bindExtensions({ mode: "rpc" });
      runtime.setRebindSession(bind);
      await bind(runtime.session);
      const coldLatency = round(performance.now() - coldStarted);
      const coldProbe = await waitForProbe(sandbox.recordPath, recordsBeforeCold, (record) => record.event === "session_start" && record.reason === "startup");
      const oldId = runtime.session.sessionId;
      const oldFile = runtime.session.sessionFile;
      sample.cold = {
        latency_ms: coldLatency,
        outcome: "ok",
        projection: projectProbe(coldProbe),
        persisted_session_file: typeof oldFile === "string",
      };

      setMarker(sandbox, "B");
      const recordsBeforeWarm = readProbeRecords(sandbox.recordPath).length;
      const warmStarted = performance.now();
      const replacement = await runtime.newSession();
      const warmLatency = round(performance.now() - warmStarted);
      if (replacement.cancelled) throw new Error("sdk_new_session_cancelled");
      const warmProbe = await waitForProbe(sandbox.recordPath, recordsBeforeWarm, (record) => record.event === "session_start" && record.reason === "new");
      sample.warm = {
        latency_ms: warmLatency,
        outcome: "ok",
        replacement: {
          session_id_changed: typeof oldId === "string" && oldId !== runtime.session.sessionId,
          session_file_changed: typeof oldFile === "string" && oldFile !== runtime.session.sessionFile,
        },
        projection: projectProbe(warmProbe),
        extension_retention: moduleRetention(coldProbe, warmProbe),
      };
      const recordsBeforeStop = readProbeRecords(sandbox.recordPath).length;
      await runtime.dispose();
      runtime = undefined;
      const shutdown = await waitForProbe(sandbox.recordPath, recordsBeforeStop, (record) => record.event === "session_shutdown" && record.reason === "quit");
      sample.shutdown = { outcome: "ok", projection: projectProbe(shutdown) };
    } catch (error) {
      const category = errorCategory(error);
      if (!sample.cold) sample.cold = { latency_ms: null, outcome: category };
      else if (!sample.warm) sample.warm = { latency_ms: null, outcome: category };
      else sample.shutdown = { outcome: category };
      if (runtime) {
        try { await runtime.dispose(); } catch { /* Best effort after a recorded SDK failure. */ }
      }
    } finally {
      process.chdir(priorCwd);
      restoreEnvironment();
    }
    samples.push(sample);
  }
  return {
    mechanism: "in_process_sdk_session_reuse",
    cold_label: "process_warm_initial_session_construction",
    cold_scope: "Pi was imported once in the benchmark runner before each sandbox set its isolated environment. This measure excludes process startup and module import/cache cost.",
    cold: summarize(samples.map((sample) => sample.cold)),
    warm_label: "same_process_session_replacement",
    warm: summarize(samples.map((sample) => sample.warm)),
    samples,
  };
}

function activationEnvironment(sandbox: Sandbox, model: string): Record<string, string> {
  const environment = cleanChildEnvironment(sandbox, model);
  const selected: Record<string, string> = {};
  for (const name of [
    "HOME",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "PI_OFFLINE",
    "PI_SKIP_VERSION_CHECK",
    "WARM_ACTIVATION_RECORD_PATH",
    "WARM_ACTIVATION_EXPECTED_CWD",
    "WARM_ACTIVATION_EXPECTED_MODEL",
  ]) {
    if (environment[name]) selected[name] = environment[name]!;
  }
  return selected;
}

function unconfiguredLauncherEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "TERM", "COLORTERM"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

async function runOnePreloadedMain(
  sandbox: Sandbox,
  options: Options,
  invalidModel = false,
  preloadedExtensions: readonly string[] = [],
) {
  const launcher = new JsonLineChild(process.execPath, [preloadedMainChildPath, ...preloadedExtensions], {
    cwd: sandbox.neutralCwd,
    env: unconfiguredLauncherEnvironment(),
  });
  const ready = await launcher.waitFor((message) => message.type === "preload_ready", 30_000);
  const recordsBefore = readProbeRecords(sandbox.recordPath).length;
  const activationStarted = performance.now();
  const model = invalidModel ? "invalid-provider/not-a-model" : options.model;
  launcher.send({
    type: "activate",
    cwd: sandbox.cwd,
    agent_dir: sandbox.agentDir,
    environment: activationEnvironment(sandbox, model),
    args: cliArgs(model, [probeExtensionPath]),
  });
  const activation = await launcher.waitFor((message) => message.type === "preload_activation_started", 10_000);
  if (invalidModel) {
    const exit = await launcher.waitForExit(30_000);
    return { ready, activation, exit };
  }
  const probe = await waitForProbe(sandbox.recordPath, recordsBefore, (record) => record.event === "session_start" && record.reason === "startup", 30_000);
  const activationLatency = round(performance.now() - activationStarted);
  const state = await launcher.request({ type: "get_state" }, 15_000);
  if (state.success !== true) throw new Error("preloaded_main_get_state_failed");
  const recordsBeforeStop = readProbeRecords(sandbox.recordPath).length;
  launcher.endInput();
  const exit = await launcher.waitForExit(20_000);
  let shutdown: JsonRecord | undefined;
  try {
    shutdown = await waitForProbe(sandbox.recordPath, recordsBeforeStop, (record) => record.event === "session_shutdown", 2_000);
  } catch {
    shutdown = readProbeRecords(sandbox.recordPath).slice(recordsBeforeStop).find((record) => record.event === "session_shutdown");
  }
  return { ready, activation, probe, state, exit, shutdown, activationLatency };
}

async function runPreloadedMainMechanism(runRoot: string, options: Options) {
  const samples: JsonRecord[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    const sandbox = createSandbox(runRoot, `preloaded-main-${index + 1}`);
    try {
      const result = await runOnePreloadedMain(sandbox, options);
      const ready = result.ready;
      const activation = result.activation;
      const probe = result.probe;
      samples.push({
        sample: `preloaded-main-${index + 1}`,
        import: {
          latency_ms: typeof ready.import_ms === "number" ? ready.import_ms : null,
          outcome: ready.main_exported === true ? "ok" : "main_not_exported",
          team_environment_clear_at_import: teamEnvironmentNames.every((name) => ready.team_environment_present_at_import?.[name] === false),
          cwd_changed_only_at_activation: typeof ready.cwd_at_import === "string" && ready.cwd_at_import !== sandbox.cwd && activation.cwd_matches_activation === true,
          rss_mb: megabytes(ready.rss_bytes),
        },
        activation: {
          latency_ms: result.activationLatency,
          outcome: "ok",
          main_exported: ready.main_exported === true,
          preloaded_extension_factory_count: typeof ready.preloaded_extension_factory_count === "number" ? ready.preloaded_extension_factory_count : 0,
          no_session_artifacts_before_activation: activation.sessions_before_activation === 0,
          no_tty_required_for_rpc: activation.stdin_is_tty === false && activation.stdout_is_tty === false,
          pre_activation_rss_mb: megabytes(activation.rss_bytes),
          projection: projectProbe(probe),
          state: projectState(result.state),
          session_rss_mb: megabytes(probe?.rss_bytes),
          single_use_lease_consumed: true,
          reentry_not_attempted: "The launcher is deliberately destroyed after its first main invocation.",
        },
        shutdown: { outcome: result.exit.code === 0 ? "ok" : "child_exit", projection: projectProbe(result.shutdown) },
      });
    } catch (error) {
      samples.push({
        sample: `preloaded-main-${index + 1}`,
        import: { latency_ms: null, outcome: errorCategory(error) },
        activation: { latency_ms: null, outcome: errorCategory(error) },
      });
    }
  }

  const failureSandbox = createSandbox(runRoot, "preloaded-main-failure");
  let failureDisposal: JsonRecord;
  try {
    const failed = await runOnePreloadedMain(failureSandbox, options, true);
    failureDisposal = {
      outcome: failed.exit.code === 0 ? "unexpected_success" : "ok",
      process_destroyed_after_failed_activation: failed.exit.code !== null || failed.exit.signal !== null,
      second_lease_not_attempted: true,
      reset_or_reuse_performed: false,
    };
  } catch (error) {
    failureDisposal = { outcome: errorCategory(error), process_destroyed_after_failed_activation: true, second_lease_not_attempted: true, reset_or_reuse_performed: false };
  }

  const activationSamples = samples.map((sample) => sample.activation);
  const importSamples = samples.map((sample) => sample.import);
  return {
    mechanism: "single_use_preloaded_pi_main",
    import: summarize(importSamples),
    activation: summarize(activationSamples),
    samples,
    one_shot_failure_disposal: failureDisposal,
    herdr_later_naming: "A preloaded child has no safe after-the-fact Herdr name. The separate pane experiment tests Herdr-owned naming at process spawn.",
  };
}

async function createInlinePtbBundle(): Promise<{ kind: "ready"; path: string } | { kind: "unavailable"; reason: string }> {
  const directory = path.join(repositoryRoot, "node_modules/.cache/pi-team-bright-warm-activation");
  fs.mkdirSync(directory, { recursive: true });
  const bundlePath = path.join(directory, `ptb-inline-${crypto.randomUUID()}.mjs`);
  const result = await runCommand("bun", [
    "build", "extensions/index.ts", "--bundle", "--format=esm", "--target=node",
    "--external=@earendil-works/pi-coding-agent",
    "--external=@earendil-works/pi-ai",
    "--external=@earendil-works/pi-tui",
    "--external=typebox",
    `--outfile=${bundlePath}`,
  ], { cwd: repositoryRoot, timeoutMs: 60_000 });
  if (!result.ok || !fs.existsSync(bundlePath)) {
    fs.rmSync(bundlePath, { force: true });
    return { kind: "unavailable", reason: result.timedOut ? "bundle_timeout" : "bun_bundle_failed" };
  }
  return { kind: "ready", path: bundlePath };
}

async function runPreloadedInlinePtbMechanism(runRoot: string, options: Options) {
  const bundle = await createInlinePtbBundle();
  if (bundle.kind !== "ready") {
    return {
      mechanism: "single_use_preloaded_inline_pi_team_bright",
      status: "not_run",
      reason: bundle.reason,
    };
  }
  try {
    const samples: JsonRecord[] = [];
    for (let index = 0; index < options.samples; index += 1) {
      const sandbox = createSandbox(runRoot, `preloaded-inline-ptb-${index + 1}`);
      try {
        const result = await runOnePreloadedMain(sandbox, options, false, [bundle.path]);
        const ready = result.ready;
        const activation = result.activation;
        const projection = projectProbe(result.probe);
        samples.push({
          sample: `preloaded-inline-ptb-${index + 1}`,
          import: {
            latency_ms: typeof ready.import_ms === "number" ? ready.import_ms : null,
            outcome: ready.main_exported === true && ready.preloaded_extension_factory_count === 1 ? "ok" : "inline_factory_missing",
            team_environment_clear_at_import: teamEnvironmentNames.every((name) => ready.team_environment_present_at_import?.[name] === false),
            preloaded_extension_factory_count: typeof ready.preloaded_extension_factory_count === "number" ? ready.preloaded_extension_factory_count : 0,
            rss_mb: megabytes(ready.rss_bytes),
          },
          activation: {
            latency_ms: result.activationLatency,
            outcome: "ok",
            no_session_artifacts_before_activation: activation.sessions_before_activation === 0,
            cwd_changed_only_at_activation: activation.cwd_matches_activation === true,
            no_tty_required_for_rpc: activation.stdin_is_tty === false && activation.stdout_is_tty === false,
            pre_activation_rss_mb: megabytes(activation.rss_bytes),
            projection,
            leader_surface_selected_before_worker_admission: projection.has_leader_only_tools,
            common_task_tools_on_leader_surface: projection.active_common_task_tools,
            exact_worker_admission: "not attempted: no prepared Membership exists in this isolated carrier experiment.",
            single_use_lease_consumed: true,
          },
          shutdown: { outcome: result.exit.code === 0 ? "ok" : "child_exit", projection: projectProbe(result.shutdown) },
        });
      } catch (error) {
        samples.push({
          sample: `preloaded-inline-ptb-${index + 1}`,
          import: { latency_ms: null, outcome: errorCategory(error) },
          activation: { latency_ms: null, outcome: errorCategory(error) },
        });
      }
    }
    const failureSandbox = createSandbox(runRoot, "preloaded-inline-ptb-failure");
    let failureDisposal: JsonRecord;
    try {
      const failed = await runOnePreloadedMain(failureSandbox, options, true, [bundle.path]);
      failureDisposal = {
        outcome: failed.exit.code === 0 ? "unexpected_success" : "ok",
        process_destroyed_after_failed_activation: failed.exit.code !== null || failed.exit.signal !== null,
        second_lease_not_attempted: true,
        reset_or_reuse_performed: false,
      };
    } catch (error) {
      failureDisposal = { outcome: errorCategory(error), process_destroyed_after_failed_activation: true, second_lease_not_attempted: true, reset_or_reuse_performed: false };
    }
    return {
      mechanism: "single_use_preloaded_inline_pi_team_bright",
      status: "run",
      import: summarize(samples.map((sample) => sample.import)),
      activation: summarize(samples.map((sample) => sample.activation)),
      samples,
      one_shot_failure_disposal: failureDisposal,
      interpretation: "Preloading the exact extension module does not create a Pi Session before activation, but the unbound process still selects the leader surface. It does not establish a Worker Membership or Task authority.",
    };
  } finally {
    fs.rmSync(bundle.path, { force: true });
  }
}

function findPaneId(text: string): string | undefined {
  const candidates: unknown[] = [];
  try { candidates.push(JSON.parse(text)); } catch { /* Some Herdr versions emit framing around JSON. */ }
  for (const match of text.matchAll(/\{[\s\S]*?\}/g)) {
    try { candidates.push(JSON.parse(match[0])); } catch { /* Continue searching. */ }
  }
  const visit = (value: any): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    for (const key of ["pane_id", "paneId"]) {
      if (typeof value[key] === "string" && value[key].includes(":")) return value[key];
    }
    for (const child of Object.values(value)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return candidates.map(visit).find(Boolean);
}

function paneIsAtInteractiveShell(command: CommandResult): boolean {
  if (!command.ok) return false;
  try {
    const info = JSON.parse(command.stdout) as any;
    const processes = info?.result?.process_info?.foreground_processes;
    return Array.isArray(processes) && processes.length === 1 && ["zsh", "bash", "sh", "fish"].includes(processes[0]?.name);
  } catch {
    return false;
  }
}

function paneTargetEnvironment(sandbox: Sandbox, model: string): string[] {
  const environment = cleanChildEnvironment(sandbox, model);
  const pairs = ["HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "WARM_ACTIVATION_RECORD_PATH", "WARM_ACTIVATION_EXPECTED_CWD", "WARM_ACTIVATION_EXPECTED_MODEL"]
    .flatMap((name) => environment[name] ? [`${name}=${environment[name]}`] : []);
  // A blank value is deliberately false for Pi Team Bright's startup role check.
  // The pane remains a carrier only; it never inherits this Worker's identity.
  pairs.push(...teamEnvironmentNames.map((name) => `${name}=`));
  return pairs;
}

async function runPaneMechanism(runRoot: string, options: Options) {
  if (!options.pane) {
    return {
      mechanism: "reserved_unbound_herdr_carrier",
      status: "not_run",
      reason: "An exact owned source pane ID is required. The runner never guesses the UI-focused pane.",
    };
  }
  const preflight = await runCommand("herdr", ["agent", "list"], { timeoutMs: 15_000 });
  const samples: JsonRecord[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    const sandbox = createSandbox(runRoot, `pane-${index + 1}`);
    let paneId: string | undefined;
    const agentName = `warm-probe-${crypto.randomUUID().slice(0, 8)}`;
    const sample: JsonRecord = { sample: `pane-${index + 1}` };
    try {
      const recordsBeforeCold = readProbeRecords(sandbox.recordPath).length;
      const coldStarted = performance.now();
      const split = await runCommand("herdr", [
        "pane", "split", "--pane", options.pane, "--direction", "right", "--ratio", "0.5", "--cwd", sandbox.cwd,
        ...paneTargetEnvironment(sandbox, options.model).flatMap((entry) => ["--env", entry]),
        "--no-focus",
      ], { timeoutMs: 20_000 });
      if (!split.ok) throw new Error("herdr_pane_split_failed");
      paneId = findPaneId(split.stdout);
      if (!paneId) throw new Error("herdr_pane_id_missing");
      const carrierBeforeStart = await Promise.all([
        runCommand("herdr", ["pane", "process-info", "--pane", paneId], { timeoutMs: 15_000 }),
        runCommand("herdr", ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "20"], { timeoutMs: 15_000 }),
      ]);
      if (!carrierBeforeStart.every((result) => result.ok)) throw new Error("herdr_carrier_shell_unavailable");
      const startArgs = [
        "agent", "start", agentName,
        "--kind", "pi",
        "--pane", paneId,
        "--timeout", "45000",
        "--",
        "--offline", "--approve", "--no-extensions", "-e", probeExtensionPath,
        "--no-skills", "--no-prompt-templates", "--no-themes",
        "--model", options.model, "--thinking", defaultThinking,
      ];
      let start = await runCommand("herdr", startArgs, { timeoutMs: 50_000 });
      let startAttempts = 1;
      if (!start.ok) {
        const afterFailure = await runCommand("herdr", ["pane", "process-info", "--pane", paneId], { timeoutMs: 15_000 });
        // Retry only when Herdr proves that the failed launch left this exact
        // owned pane at a shell prompt. Never type into an unknown carrier.
        if (!paneIsAtInteractiveShell(afterFailure)) throw new Error("herdr_agent_start_failed");
        start = await runCommand("herdr", startArgs, { timeoutMs: 50_000 });
        startAttempts += 1;
      }
      if (!start.ok) throw new Error("herdr_agent_start_failed");
      const coldProbe = await waitForProbe(sandbox.recordPath, recordsBeforeCold, (record) => record.event === "session_start" && record.reason === "startup", 45_000);
      sample.cold = {
        latency_ms: round(performance.now() - coldStarted),
        outcome: "ok",
        projection: projectProbe(coldProbe),
        named_by_herdr_at_spawn: true,
        agent_start_attempts: startAttempts,
      };

      const recordsBeforeWarm = readProbeRecords(sandbox.recordPath).length;
      const warmStarted = performance.now();
      const prompt = await runCommand("herdr", ["agent", "prompt", agentName, "/warm-activation-probe"], { timeoutMs: 25_000 });
      if (!prompt.ok) throw new Error("herdr_agent_prompt_failed");
      const warmProbe = await waitForProbe(sandbox.recordPath, recordsBeforeWarm, (record) => record.event === "activation_command", 10_000);
      sample.warm = {
        latency_ms: round(performance.now() - warmStarted),
        outcome: "ok",
        projection: projectProbe(warmProbe),
        interpretation: "This is a local command in an unbound carrier. It is not Membership, readiness, or Task authority evidence.",
      };

      const inspection = await Promise.all([
        runCommand("herdr", ["agent", "get", agentName], { timeoutMs: 15_000 }),
        runCommand("herdr", ["agent", "read", agentName, "--source", "recent-unwrapped"], { timeoutMs: 15_000 }),
        runCommand("herdr", ["pane", "get", paneId], { timeoutMs: 15_000 }),
        runCommand("herdr", ["pane", "process-info", "--pane", paneId], { timeoutMs: 15_000 }),
      ]);
      sample.observation = {
        named_agent_observed: inspection[0].ok,
        agent_output_read: inspection[1].ok,
        exact_pane_observed: inspection[2].ok,
        pane_process_observed: inspection[3].ok,
      };

      const recordsBeforeShutdown = readProbeRecords(sandbox.recordPath).length;
      const gracefulShutdown = await runCommand("herdr", ["agent", "prompt", agentName, "/warm-activation-shutdown"], { timeoutMs: 25_000 });
      if (!gracefulShutdown.ok) throw new Error("herdr_agent_shutdown_prompt_failed");
      const shutdownProbe = await waitForProbe(sandbox.recordPath, recordsBeforeShutdown, (record) => record.event === "session_shutdown", 15_000);
      sample.shutdown = { outcome: "ok", projection: projectProbe(shutdownProbe) };
    } catch (error) {
      const category = errorCategory(error);
      if (!sample.cold) sample.cold = { latency_ms: null, outcome: category };
      else if (!sample.warm) sample.warm = { latency_ms: null, outcome: category };
      else if (!sample.observation) sample.observation = { outcome: category };
      else sample.shutdown = { outcome: category };
    } finally {
      if (paneId) {
        const close = await runCommand("herdr", ["pane", "close", paneId], { timeoutMs: 20_000 });
        if (close.ok) {
          const [agentAfterClose, paneAfterClose] = await Promise.all([
            runCommand("herdr", ["agent", "get", agentName], { timeoutMs: 15_000 }),
            runCommand("herdr", ["pane", "get", paneId], { timeoutMs: 15_000 }),
          ]);
          sample.cleanup = {
            created_pane_closed: true,
            named_agent_absent_after_close: !agentAfterClose.ok,
            pane_absent_after_close: !paneAfterClose.ok,
          };
        } else {
          sample.cleanup = {
            created_pane_closed: false,
            named_agent_absent_after_close: false,
            pane_absent_after_close: false,
          };
        }
      } else {
        sample.cleanup = {
          created_pane_closed: false,
          named_agent_absent_after_close: false,
          pane_absent_after_close: false,
        };
      }
    }
    samples.push(sample);
  }
  return {
    mechanism: "reserved_unbound_herdr_carrier",
    status: "run",
    query_before_control: { herdr_agent_list_ok: preflight.ok },
    cold: summarize(samples.map((sample) => sample.cold)),
    warm: summarize(samples.map((sample) => sample.warm)),
    samples,
  };
}

function readPackageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
  } catch {
    return "unavailable";
  }
}

async function gitCommit(): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, timeoutMs: 10_000 });
  return result.ok ? result.stdout.trim() : "unavailable";
}

function overallStatus(results: JsonRecord): "complete" | "partial" {
  const sessionMechanisms = [results.rpc, results.sdk, results.pane];
  const sessionPathsPass = sessionMechanisms.every((result) => result?.cold?.successes > 0 && result?.warm?.successes > 0);
  const preloadPathsPass = [results.preloaded_main, results.preloaded_inline_ptb]
    .every((result) => result?.import?.successes > 0 && result?.activation?.successes > 0);
  return sessionPathsPass && preloadPathsPass ? "complete" : "partial";
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-warm-activation-"));
  let temporaryRootRemoved = false;
  try {
    const rpc = await runRpcMechanism(runRoot, options);
    const sdk = await runSdkMechanism(runRoot, options);
    const preloadedMain = await runPreloadedMainMechanism(runRoot, options);
    const preloadedInlinePtb = await runPreloadedInlinePtbMechanism(runRoot, options);
    const pane = await runPaneMechanism(runRoot, options);
    const result: JsonRecord = {
      schema: SCHEMA,
      status: overallStatus({ rpc, sdk, preloaded_main: preloadedMain, preloaded_inline_ptb: preloadedInlinePtb, pane }),
      generated_at: new Date().toISOString(),
      source: {
        commit: await gitCommit(),
        pi_version: readPackageVersion(),
        node_version: process.version,
        platform: process.platform,
        architecture: process.arch,
        kernel: os.release(),
      },
      parameters: {
        requested_samples_per_mechanism: options.samples,
        launch_profile: { model: options.model, thinking: defaultThinking, projection: "explicit CLI profile; observed again from each Session" },
        model_prompts_sent: false,
        network_mode: "offline",
        raw_probe_identity_records: "Temporary only; this durable artifact retains every individual timing and derived invariant without Session IDs, process IDs, paths, prompts, or credentials.",
      },
      rpc,
      sdk,
      preloaded_main: preloadedMain,
      preloaded_inline_ptb: preloadedInlinePtb,
      pane,
      decision: {
        architecture_impact: "none",
        ranked_mechanisms: [
          { rank: 1, mechanism: "No production warm carrier", decision: "Keep the current one-process-per-Membership startup and exact Session admission contract." },
          { rank: 2, mechanism: "Persistent RPC Session replacement", decision: "Useful only as a controlled Session-replacement benchmark. Its process role, cwd, environment, and resource projection remain launch-fixed." },
          { rank: 3, mechanism: "In-process SDK Session reuse", decision: "Useful only as a controlled Session-replacement benchmark. Module-level extension state can survive within the process." },
          { rank: 4, mechanism: "Single-use preloaded Pi main", decision: "Can lower single-use activation time, but remains a fresh process with no after-the-fact Worker admission or Herdr naming path." },
          { rank: 5, mechanism: "Single-use preloaded inline Pi Team Bright factory", decision: "The unbound process still selects leader tools. It is not an exact Worker admission path." },
          { rank: 6, mechanism: "Reserved unbound Herdr carrier", decision: "Can run a fast local command, but must never imply Worker Membership, readiness, progress, or Task authority." },
        ],
        reversal_evidence: "A proposed production seam must prove exact Worker admission, one process generation per Membership, fresh Worker resource projection, post-bind Worker-only tool projection, and terminal observation without unchecked carrier reuse.",
      },
      cleanup: {
        temporary_root_removed: false,
        panes_created_by_runner_closed_and_absent: pane?.samples?.every((sample: JsonRecord) =>
          sample.cleanup?.created_pane_closed === true
          && sample.cleanup?.named_agent_absent_after_close === true
          && sample.cleanup?.pane_absent_after_close === true,
        ) ?? false,
      },
    };
    fs.rmSync(runRoot, { recursive: true, force: true });
    temporaryRootRemoved = true;
    result.cleanup.temporary_root_removed = true;
    fs.mkdirSync(path.dirname(options.artifactPath), { recursive: true });
    const temporaryArtifact = `${options.artifactPath}.tmp`;
    fs.writeFileSync(temporaryArtifact, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryArtifact, options.artifactPath);
    process.stdout.write(`${JSON.stringify({ status: result.status, artifact: path.relative(repositoryRoot, options.artifactPath) })}\n`);
  } finally {
    if (!temporaryRootRemoved) fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`warm activation runner failed: ${errorCategory(error)}\n`);
  process.exitCode = 1;
});
