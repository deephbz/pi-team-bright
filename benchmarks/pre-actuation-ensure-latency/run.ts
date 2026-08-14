import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

type Condition = "isolated" | "loaded" | "directory_loaded";

type ChildTrace = {
  status: "complete" | "error";
  error_kind?: string;
  phases_ms: Record<string, number>;
  ensure_to_membership_prepared_ms?: number;
  bridge_to_membership_prepared_ms?: number;
  lock_wait_total_ms?: number;
  post_prepared_to_launch_boundary_ms?: number;
  boundary?: Record<string, boolean | number>;
  phase_order: string[];
  worker_index: number;
  aggregate_paths: string[];
};

type ChildResult = {
  schema: string;
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
  traces: ChildTrace[];
  reconciliation: {
    calls_total: number;
    calls_before_boundary: number;
    beads_calls_before_boundary: number;
    conclusion: string;
  };
};

type ChildSample = {
  condition: Condition;
  sample_index: number;
  child_wall_ms: number;
  child_exit_code: number | null;
  child_status: "complete" | "partial" | "error";
  result: ChildResult | null;
  error_kind?: string;
};

type Arguments = {
  samples: number;
  loadWidth: number;
  foreignTeams: number;
  artifact: string;
  debug: boolean;
};


const DEFAULT_ARTIFACT = "docs/journal/artifacts/2026-08-14-pre-actuation-ensure-latency-results.json";
const PHASES = [
  "leader_binding_and_config",
  "logical_worker_persistence",
  "bridge_team_exists",
  "bridge_team_config_read",
  "terminal_detection",
  "bridge_team_config_and_terminal_detection",
  "worker_resource_aggregate_projection",
  "model_resolution",
  "membership_persistence",
  "prepared_event_publication",
  "unattributed_bridge_overhead",
  "unattributed_application_overhead",
] as const;

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
    if (option !== "--samples" && option !== "--load-width" && option !== "--foreign-teams" && option !== "--artifact") {
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
    samples: parseInteger(values.get("--samples") ?? "7", "--samples", 1, 20),
    loadWidth: parseInteger(values.get("--load-width") ?? "4", "--load-width", 1, 8),
    foreignTeams: parseInteger(values.get("--foreign-teams") ?? "32", "--foreign-teams", 0, 128),
    artifact,
    debug,
  };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceBundleHash(repository: string): string {
  const files = ["README.md", "plan.json", "child.ts", "run.ts"].map((name) => path.join(repository, "benchmarks/pre-actuation-ensure-latency", name));
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

function piVersion(): string | null {
  const result = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/);
  return match?.[0] ?? null;
}

function bunVersion(): string | null {
  const result = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 15_000 });
  return result.status === 0 ? result.stdout.trim() || null : null;
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
    max_ms: rounded(sorted[sorted.length - 1]!),
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
  ]) delete environment[key];
  const home = path.join(root, "home");
  environment.HOME = home;
  environment.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
  environment.PI_OFFLINE = "1";
  environment.PTB_BENCH_REPOSITORY = repository;
  environment.PTB_BENCH_PROJECT = path.join(root, "project");
  if (debug) environment.PTB_BENCH_DEBUG = "1";
  else delete environment.PTB_BENCH_DEBUG;
  return environment;
}

function parseChild(stdout: string): ChildResult | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return null;
  try {
    const result = JSON.parse(last) as ChildResult;
    return result?.schema === "pi-team-bright/pre-actuation-ensure-child/1" ? result : null;
  } catch {
    return null;
  }
}

function childSample(
  repository: string,
  condition: Condition,
  sampleIndex: number,
  workers: number,
  foreignTeams: number,
  debug: boolean,
): ChildSample {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-pre-actuation-"));
  const started = performance.now();
  try {
    const child = path.join(repository, "benchmarks", "pre-actuation-ensure-latency", "child.ts");
    const result = spawnSync("bun", [child,
      "--condition", condition,
      "--workers", String(workers),
      "--foreign-teams", String(foreignTeams),
    ], {
      cwd: repository,
      env: cleanEnvironment(root, repository, debug),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = parseChild(result.stdout ?? "");
    const errorKind = parsed
      ? undefined
      : result.error
        ? "ChildProcessError"
        : result.signal
          ? "ChildSignal"
          : "ChildOutputInvalid";
    if (debug && result.stderr) process.stderr.write(result.stderr);
    return {
      condition,
      sample_index: sampleIndex,
      child_wall_ms: rounded(performance.now() - started),
      child_exit_code: result.status,
      child_status: parsed?.status ?? "error",
      result: parsed,
      ...(errorKind ? { error_kind: errorKind } : {}),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function currentProfileModelResolverProbe(repository: string, samples: number) {
  const list = spawnSync("pi", ["--list-models"], { encoding: "utf8", timeout: 15_000 });
  const candidate = list.status === 0
    ? list.stdout.split("\n").map((line) => line.trim().split(/\s+/)).find((parts) => parts.length >= 2 && parts[0] !== "provider")
    : undefined;
  if (!candidate?.[0] || !candidate[1]) {
    return {
      scope: "active_profile_external_microprobe",
      status: "unavailable",
      reason: "no_public_catalog_candidate",
      samples: [],
      summary: summary([]),
    };
  }
  const candidateName = `${candidate[0]}/${candidate[1]}`;
  let resolver: ((value: string) => string | null) | undefined;
  try {
    resolver = require(path.join(repository, "src/utils/worker-resource-projection.ts")).resolveQualifiedWorkerDefaultModel;
  } catch {
    return {
      scope: "active_profile_external_microprobe",
      status: "unavailable",
      reason: "resolver_import_failed",
      samples: [],
      summary: summary([]),
    };
  }
  const durations: number[] = [];
  let matches = 0;
  let errors = 0;
  for (let index = 0; index < samples; index += 1) {
    try {
      const started = performance.now();
      const result = resolver(candidateName);
      durations.push(rounded(performance.now() - started));
      if (result === candidateName) matches += 1;
    } catch {
      errors += 1;
    }
  }
  return {
    scope: "active_profile_external_microprobe",
    status: errors === 0 && matches === samples ? "complete" : "partial",
    candidate_identity_redacted: true,
    samples_ms: durations,
    successful_matches: matches,
    errors,
    summary: summary(durations),
  };
}

function conditionSummary(samples: readonly ChildSample[]) {
  const traces = samples.flatMap((sample) => sample.result?.traces ?? []).filter((trace) => trace.status === "complete");
  const total = summary(traces.flatMap((trace) => trace.ensure_to_membership_prepared_ms === undefined ? [] : [trace.ensure_to_membership_prepared_ms]));
  const bridge = summary(traces.flatMap((trace) => trace.bridge_to_membership_prepared_ms === undefined ? [] : [trace.bridge_to_membership_prepared_ms]));
  const lock = summary(traces.flatMap((trace) => trace.lock_wait_total_ms === undefined ? [] : [trace.lock_wait_total_ms]));
  const postPrepared = summary(traces.flatMap((trace) => trace.post_prepared_to_launch_boundary_ms === undefined ? [] : [trace.post_prepared_to_launch_boundary_ms]));
  const phases = Object.fromEntries(PHASES.map((phase) => [phase, summary(traces.map((trace) => trace.phases_ms[phase] ?? 0))]));
  const validationFailures = samples.flatMap((sample) => sample.result?.traces ?? []).filter((trace) => trace.status !== "complete").length;
  return {
    sample_groups: samples.length,
    complete_trace_count: traces.length,
    validation_failure_count: validationFailures + samples.filter((sample) => !sample.result).length,
    ensure_to_membership_prepared_ms: total,
    bridge_to_membership_prepared_ms: bridge,
    lock_wait_total_ms: lock,
    post_prepared_to_launch_boundary_ms: postPrepared,
    phases_ms: phases,
    child_process_wall_ms_outside_target: summary(samples.map((sample) => sample.child_wall_ms)),
    child_setup_ms_outside_target: summary(samples.flatMap((sample) => sample.result ? [sample.result.setup_ms] : [])),
  };
}

function redactedChildSample(sample: ChildSample) {
  if (!sample.result) return { ...sample, result: undefined };
  return {
    condition: sample.condition,
    sample_index: sample.sample_index,
    child_wall_ms: sample.child_wall_ms,
    child_exit_code: sample.child_exit_code,
    child_status: sample.child_status,
    result: {
      ...sample.result,
      traces: sample.result.traces.map((trace) => ({ ...trace, aggregate_paths: [] })),
    },
  };
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  const repository = process.cwd();
  const samples: ChildSample[] = [];
  for (let index = 0; index < args.samples; index += 1) {
    samples.push(childSample(repository, "isolated", index, 1, 0, args.debug));
  }
  for (let index = 0; index < args.samples; index += 1) {
    samples.push(childSample(repository, "loaded", index, args.loadWidth, 0, args.debug));
  }
  for (let index = 0; index < args.samples; index += 1) {
    samples.push(childSample(repository, "directory_loaded", index, 1, args.foreignTeams, args.debug));
  }

  const byCondition = Object.fromEntries(([
    "isolated",
    "loaded",
    "directory_loaded",
  ] as const).map((condition) => [condition, conditionSummary(samples.filter((sample) => sample.condition === condition))]));
  const sourceFences = samples.flatMap((sample) => sample.result ? [sample.result.source_fence] : []);
  const sourceFence = sourceFences[0] ?? { bridge_sha256: "", application_sha256: "", ordering_verified: false };
  const sourceFenceStable = sourceFences.every((candidate) => candidate.bridge_sha256 === sourceFence.bridge_sha256
    && candidate.application_sha256 === sourceFence.application_sha256
    && candidate.ordering_verified === sourceFence.ordering_verified);
  const reconciliation = samples.flatMap((sample) => sample.result ? [sample.result.reconciliation] : []);
  const allBoundaryChecksPass = samples.length > 0
    && samples.every((sample) => sample.result?.status === "complete")
    && samples.flatMap((sample) => sample.result?.traces ?? []).every((trace) => trace.status === "complete");
  const output = {
    schema: "pi-team-bright/pre-actuation-ensure-latency-results/1",
    recorded_at: new Date().toISOString(),
    source: {
      revision: git(repository, ["rev-parse", "HEAD"]),
      source_bundle_sha256: sourceBundleHash(repository),
      worktree_dirty_at_measurement: git(repository, ["status", "--porcelain"]) !== "",
      files: [
        "benchmarks/pre-actuation-ensure-latency/README.md",
        "benchmarks/pre-actuation-ensure-latency/plan.json",
        "benchmarks/pre-actuation-ensure-latency/child.ts",
        "benchmarks/pre-actuation-ensure-latency/run.ts",
        "src/model-tool-contract/durable-model-tool-team-application.ts",
        "src/team-authority/worker-launch-bridge.ts",
      ],
      source_fence: { ...sourceFence, stable_across_children: sourceFenceStable },
    },
    environment: {
      node_version: process.version.replace(/^v/, ""),
      bun_version: bunVersion(),
      pi_version: piVersion(),
      platform: `${process.platform}-${process.arch}`,
      child_runtime: "fresh Bun process",
      resource_profile: "fresh temporary home, agent directory, and project",
    },
    design: {
      target_interval: "model-tool ensure entry to durable prepared-event completion",
      post_target_boundary: "launchPreparedMembership entry before its spawn callback",
      external_comparison_anchor: {
        reported_exact_source_canary_ensure_started_to_membership_prepared_ms: 5012,
        status: "not reproduced; ambient workload and state are unknown",
      },
      conditions: {
        isolated: "one ensure in one fresh isolated process and Team",
        loaded: `${args.loadWidth} concurrent ensures for distinct Workers in one fresh isolated Team`,
        directory_loaded: `one ensure with ${args.foreignTeams} unrelated valid Team records in its fresh isolated home`,
      },
      model_resolution: "The integrated lanes execute a local qualified-model validator. The current-profile production pi --list-models helper is sampled separately with its candidate identity redacted.",
      task_reconciliation: "The boundary makes WorkerLaunchBridge.ensureWorker return unavailable before DurableModelToolTeamApplication can call reconcileReady. No Beads operation is reachable before the target endpoint.",
    },
    raw_samples: samples.map(redactedChildSample),
    summaries: byCondition,
    external_model_catalog_resolver: currentProfileModelResolverProbe(repository, args.samples),
    verification: {
      all_boundary_checks_pass: allBoundaryChecksPass,
      prepared_event_and_membership_checks: "Each complete trace verifies a current pending-launch Membership, matching prepared event, zero Session files, zero spawn calls, and aggregate cleanup.",
      task_reconciliation_records: reconciliation,
      quantile_method: "nearest-rank: ceil(p * n) - 1 after ascending sort",
      scope_limit: "No terminal actuation, Pi process creation, Pi Session binding, startup observation, Beads reconciliation, or full ensure latency is measured by the target interval.",
    },
  };
  const destination = path.resolve(repository, args.artifact);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ artifact: args.artifact, complete: allBoundaryChecksPass, source_bundle_sha256: output.source.source_bundle_sha256 })}\n`);
  if (!allBoundaryChecksPass) process.exitCode = 2;
}

if (typeof require !== "undefined" && require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`Pre-actuation ensure benchmark failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
