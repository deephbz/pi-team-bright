import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

type Scenario =
  | "accepted_bound"
  | "stable_reuse"
  | "early_exit"
  | "live_unbound_timeout"
  | "pane_loss"
  | "late_binding_at_timeout"
  | "concurrent_ensure"
  | "leader_restart"
  | "stop"
  | "shutdown"
  | "task_delivery_before_binding";

type ChildResult = {
  schema: "pi-team-bright/nonblocking-accepted-launch-supervision-child/2";
  status: "complete" | "partial" | "error";
  scenario: Scenario;
  source_fence?: Record<string, unknown>;
  timing_ms?: Record<string, number>;
  observations?: Record<string, boolean | number | string>;
  safety_assertions?: Record<string, boolean>;
  operation?: Record<string, unknown>;
  carrier_count?: number;
  child_elapsed_ms?: number;
  error_kind?: string;
};

type Sample = {
  scenario: Scenario;
  sample_index: number;
  child_wall_ms: number;
  child_exit_code: number | null;
  result: ChildResult | null;
  error_kind?: string;
};

type Arguments = {
  samples: number;
  adversarialSamples: number;
  artifact: string;
  debug: boolean;
};

const DEFAULT_ARTIFACT = "docs/journal/artifacts/2026-08-14-nonblocking-accepted-launch-supervision-integrated-source-recheck.json";
const MEASURED: readonly Scenario[] = ["accepted_bound", "stable_reuse"];
const ADVERSARIAL: readonly Scenario[] = [
  "early_exit",
  "live_unbound_timeout",
  "pane_loss",
  "late_binding_at_timeout",
  "concurrent_ensure",
  "leader_restart",
  "stop",
  "shutdown",
  "task_delivery_before_binding",
];

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseInteger(value: string | undefined, option: string, minimum: number, maximum: number): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${option} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${option} must be from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  let debug = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--debug") {
      debug = true;
      continue;
    }
    if (option !== "--samples" && option !== "--adversarial-samples" && option !== "--artifact") {
      throw new Error(`Unknown option: ${option ?? "<missing>"}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values.has(option)) throw new Error(`${option} requires one value.`);
    values.set(option, value);
    index += 1;
  }
  const artifact = values.get("--artifact") ?? DEFAULT_ARTIFACT;
  if (path.isAbsolute(artifact) || artifact.split(path.sep).includes("..")) {
    throw new Error("--artifact must be a repository-relative path.");
  }
  return {
    samples: parseInteger(values.get("--samples") ?? "7", "--samples", 1, 30),
    adversarialSamples: parseInteger(values.get("--adversarial-samples") ?? "1", "--adversarial-samples", 1, 10),
    artifact,
    debug,
  };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceBundleHash(repository: string): string {
  const files = ["README.md", "plan.json", "child.ts", "run.ts"]
    .map((name) => path.join(repository, "benchmarks/nonblocking-accepted-launch-supervision", name));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.basename(file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function git(repository: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 15_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function bunVersion(): string | null {
  const result = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 15_000 });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function piVersion(): string | null {
  const result = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/);
  return match?.[0] ?? null;
}

function herdrContract() {
  const version = spawnSync("herdr", ["--version"], { encoding: "utf8", timeout: 15_000 });
  const help = spawnSync("herdr", ["agent", "start", "--help"], { encoding: "utf8", timeout: 15_000 });
  const text = `${help.stdout}\n${help.stderr}`;
  return {
    command_available: version.status === 0 && help.status === 0,
    version: version.status === 0 ? version.stdout.trim() || null : null,
    accepted_wait_option_present: /(?:^|\s)--wait(?:\s|$)/m.test(text),
    interactive_ready_contract_present: /interactive readiness|ready for input/i.test(text),
    help_exit_code: help.status,
    interpretation: /(?:^|\s)--wait(?:\s|$)/m.test(text)
      ? "A positive accepted-start capability still needs live contract validation."
      : "No accepted-start option is exposed by installed help; live accepted-actuation timing is unavailable.",
  };
}

function summary(values: readonly number[]) {
  const sorted = [...values].filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return { n: 0, min_ms: null, p50_ms: null, p95_ms: null, max_ms: null };
  const quantile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    n: sorted.length,
    min_ms: rounded(sorted[0]!),
    p50_ms: rounded(quantile(0.5)),
    p95_ms: rounded(quantile(0.95)),
    max_ms: rounded(sorted.at(-1)!),
  };
}

function cleanEnvironment(root: string, repository: string, debug: boolean): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    "PI_AGENT_NAME",
    "PI_TEAM_NAME",
    "PI_TEAM_MEMBERSHIP_ID",
    "PI_AGENT_LAUNCH_ID",
    "PI_SESSION_FILE",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT",
    "PI_TEAM_BRIGHT_MODEL_TOOL",
    "PI_TEAM_BRIGHT_WORKER_AGGREGATE",
    "PI_MODEL",
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_TAB_ID",
  ]) delete environment[key];
  const home = path.join(root, "home");
  environment.HOME = home;
  environment.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
  environment.PI_OFFLINE = "1";
  environment.PTB_NB_REPOSITORY = repository;
  environment.PTB_NB_PROJECT = path.join(root, "project");
  if (debug) environment.PTB_NB_DEBUG = "1";
  else delete environment.PTB_NB_DEBUG;
  return environment;
}

function parseChild(stdout: string): ChildResult | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return null;
  try {
    const result = JSON.parse(last) as ChildResult;
    return result?.schema === "pi-team-bright/nonblocking-accepted-launch-supervision-child/2" ? result : null;
  } catch {
    return null;
  }
}

function childSample(repository: string, scenario: Scenario, sampleIndex: number, debug: boolean): Sample {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-nonblocking-supervision-"));
  const started = performance.now();
  try {
    const child = path.join(repository, "benchmarks/nonblocking-accepted-launch-supervision/child.ts");
    const result = spawnSync("bun", [child, "--scenario", scenario], {
      cwd: repository,
      env: cleanEnvironment(root, repository, debug),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = parseChild(result.stdout ?? "");
    if (debug && result.stderr) process.stderr.write(result.stderr);
    const errorKind = parsed
      ? undefined
      : result.error
        ? "ChildProcessError"
        : result.signal
          ? "ChildSignal"
          : "ChildOutputInvalid";
    return {
      scenario,
      sample_index: sampleIndex,
      child_wall_ms: rounded(performance.now() - started),
      child_exit_code: result.status,
      result: parsed,
      ...(errorKind ? { error_kind: errorKind } : {}),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function redactedSample(sample: Sample) {
  if (!sample.result) return { ...sample, result: undefined };
  return {
    scenario: sample.scenario,
    sample_index: sample.sample_index,
    child_wall_ms: sample.child_wall_ms,
    child_exit_code: sample.child_exit_code,
    result: sample.result,
  };
}

function scenarioSummary(samples: readonly Sample[], timingNames: readonly string[]) {
  const complete = samples.filter((sample) => sample.result?.status === "complete");
  return {
    samples: samples.length,
    complete: complete.length,
    failed: samples.length - complete.length,
    timings_ms: Object.fromEntries(timingNames.map((name) => [
      name,
      summary(complete.flatMap((sample) => typeof sample.result?.timing_ms?.[name] === "number" ? [sample.result.timing_ms[name]!] : [])),
    ])),
    all_safety_assertions_pass: complete.length === samples.length && complete.every((sample) =>
      Object.values(sample.result?.safety_assertions ?? {}).every(Boolean)),
    observation_count: complete.reduce((count, sample) => count + Object.keys(sample.result?.observations ?? {}).length, 0),
  };
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  const repository = process.cwd();
  const samples: Sample[] = [];
  for (const scenario of MEASURED) {
    for (let index = 0; index < args.samples; index += 1) {
      samples.push(childSample(repository, scenario, index, args.debug));
    }
  }
  for (const scenario of ADVERSARIAL) {
    for (let index = 0; index < args.adversarialSamples; index += 1) {
      samples.push(childSample(repository, scenario, index, args.debug));
    }
  }

  const accepted = samples.filter((sample) => sample.scenario === "accepted_bound");
  const reused = samples.filter((sample) => sample.scenario === "stable_reuse");
  const adversarial = Object.fromEntries(ADVERSARIAL.map((scenario) => [
    scenario,
    scenarioSummary(samples.filter((sample) => sample.scenario === scenario), []),
  ]));
  const fences = samples.flatMap((sample) => sample.result?.source_fence ? [sample.result.source_fence] : []);
  const sourceFence = fences[0] ?? {};
  const sourceFenceStable = fences.length === samples.length && fences.every((fence) => JSON.stringify(fence) === JSON.stringify(sourceFence));
  const allComplete = samples.length > 0 && samples.every((sample) => sample.result?.status === "complete");
  const allSafetyAssertionsPass = allComplete && samples.every((sample) =>
    Object.values(sample.result?.safety_assertions ?? {}).every(Boolean));
  const output = {
    schema: "pi-team-bright/nonblocking-accepted-launch-supervision-results/2",
    recorded_at: new Date().toISOString(),
    source: {
      revision: git(repository, ["rev-parse", "HEAD"]),
      source_bundle_sha256: sourceBundleHash(repository),
      worktree_dirty_at_measurement: git(repository, ["status", "--porcelain"]) !== "",
      files: [
        "benchmarks/nonblocking-accepted-launch-supervision/README.md",
        "benchmarks/nonblocking-accepted-launch-supervision/plan.json",
        "benchmarks/nonblocking-accepted-launch-supervision/child.ts",
        "benchmarks/nonblocking-accepted-launch-supervision/run.ts",
        "src/utils/teams.ts",
        "src/utils/runtime.ts",
        "src/team-authority/worker-launch-bridge.ts",
        "src/team-authority/team-session-lifecycle-service.ts",
        "src/team-authority/team-lifecycle-service.ts",
      ],
      source_fence: { ...sourceFence, stable_across_children: sourceFenceStable },
    },
    environment: {
      node_version: process.version.replace(/^v/, ""),
      bun_version: bunVersion(),
      pi_version: piVersion(),
      platform: `${process.platform}-${process.arch}`,
      child_runtime: "fresh Bun process",
      resource_profile: "fresh temporary home, agent directory, project, Team, operation store, and synthetic carrier registry",
    },
    herdr_contract: herdrContract(),
    design: {
      response_boundary: "ensure start through durable accepted operation record after exact target persistence",
      later_binding_boundary: "accepted result through exact Session, runtime-generation, and session-bound event match",
      accepted_actuation: "synthetic exact response only; installed Herdr help did not expose an accepted-start option",
      capacity_rule: "prepared and accepted operations are not reusable capacity; only exact bound Memberships are reused",
      cleanup_rule: "terminal unbound operations persist their terminal state before fenced exact target cleanup and Membership deactivation",
      task_delivery_rule: "the durable delivery membership adapter returns no recipient before an exact Session binding",
    },
    raw_samples: samples.map(redactedSample),
    summaries: {
      accepted_bound: scenarioSummary(accepted, ["response_ms", "later_binding_ms"]),
      stable_reuse: scenarioSummary(reused, ["first_response_ms", "later_binding_ms", "stable_reuse_response_ms"]),
      adversarial,
    },
    verification: {
      all_samples_complete: allComplete,
      all_safety_assertions_pass: allSafetyAssertionsPass,
      observation_rule: "Observations record what the source and prototype returned. Only named safety assertions determine pass or fail.",
      quantile_method: "nearest-rank: ceil(p * n) - 1 after ascending sort",
      independent_anchor: "Each child reads current source and exercises durable Membership, runtime, Session-admission, event, terminal-lifecycle, and delivery-membership contracts in a fresh isolated state directory.",
      contract_limit: "The installed Herdr CLI did not expose accepted start. Synthetic accepted actuation validates the operation supervisor seam but not a real Herdr protocol, pane, or Pi process.",
    },
    limits: [
      "This is a disposable prototype. It adds no production operation authority, Membership schema field, terminal adapter behavior, or model-tool result contract.",
      "A synthetic carrier registry cannot prove real Herdr acceptance, crash behavior, pane loss semantics, or process cleanup.",
      "The bound simulation invokes current Session admission in the benchmark process. It proves the durable admission order and fences, not real Pi startup latency.",
      "The historical 2026-08-14 raw record captured a source planner that reused a live prepared carrier. This recheck separately records the integrated planner observation and requires its safe refusal.",
      "No full ensure p95 or 100 ms product claim follows from these measurements.",
    ],
  };
  const destination = path.resolve(repository, args.artifact);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ artifact: args.artifact, complete: allSafetyAssertionsPass, source_bundle_sha256: output.source.source_bundle_sha256 })}\n`);
  if (!allSafetyAssertionsPass) process.exitCode = 2;
}

if (typeof require !== "undefined" && require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`Nonblocking accepted-launch supervision benchmark failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
