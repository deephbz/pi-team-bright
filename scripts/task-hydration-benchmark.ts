import { performance } from "node:perf_hooks";
import {
  listTaskIds,
  readTaskAuthorityRecordEnvelopes,
} from "../src/model-tool-contract/beads-authority-adapter";
import { BeadsError, DEFAULT_BD_TIMEOUT_MS } from "../src/utils/beads";

export const TASK_HYDRATION_BENCHMARK_SCHEMA = "pi-team-bright/task-hydration-benchmark/1" as const;

export interface BenchmarkArguments {
  teamName: string;
  samples: number;
  hydrationCounts: number[];
}

export interface MeasurementSummary {
  requestedSamples: number;
  attemptedSamples: number;
  successes: number;
  timeouts: number;
  errors: number;
  skippedSamples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface TaskHydrationBenchmarkResult {
  schema: typeof TASK_HYDRATION_BENCHMARK_SCHEMA;
  status: "complete" | "partial";
  productionTimeoutMs: number;
  workload: {
    samples: number;
    hydrationCounts: number[];
  };
  measurements: {
    teamScopedList: MeasurementSummary;
    exactBatchHydration: Array<MeasurementSummary & { taskCount: number }>;
  };
}

interface MutableMeasurement {
  durationsMs: number[];
  attemptedSamples: number;
  successes: number;
  timeouts: number;
  errors: number;
  skippedSamples: number;
}

export interface BenchmarkDependencies {
  list(teamName: string): Promise<string[]>;
  hydrate(teamName: string, taskIds: readonly string[]): Promise<readonly unknown[]>;
  now(): number;
}

const productionDependencies: BenchmarkDependencies = {
  list: listTaskIds,
  hydrate: readTaskAuthorityRecordEnvelopes,
  now: () => performance.now(),
};

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive safe integer.`);
  }
  return parsed;
}

export function parseBenchmarkArguments(argv: readonly string[]): BenchmarkArguments {
  const values = new Map<string, string>();
  const allowed = new Set(["--team", "--samples", "--counts"]);
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option || !allowed.has(option)) throw new Error(`Unknown benchmark option: ${option || "<missing>"}.`);
    if (values.has(option)) throw new Error(`Benchmark option ${option} can occur only once.`);
    if (value === undefined || value.startsWith("--")) throw new Error(`Benchmark option ${option} requires a value.`);
    values.set(option, value);
  }

  const teamName = values.get("--team")?.trim();
  if (!teamName) throw new Error("--team is required and must not be empty.");
  const sampleValue = values.get("--samples");
  if (!sampleValue) throw new Error("--samples is required.");
  const countValue = values.get("--counts");
  if (!countValue) throw new Error("--counts is required.");

  const samples = parsePositiveInteger(sampleValue, "--samples");
  const rawCounts = countValue.split(",");
  if (rawCounts.some((value) => value.length === 0)) {
    throw new Error("--counts must be a comma-separated list of positive integers.");
  }
  const hydrationCounts = [...new Set(rawCounts.map((value) => parsePositiveInteger(value, "--counts")))]
    .sort((left, right) => left - right);

  return { teamName, samples, hydrationCounts };
}

function percentile(sorted: readonly number[], percentage: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[rank] ?? null;
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

export function summarizeMeasurement(
  measurement: MutableMeasurement,
  requestedSamples: number,
): MeasurementSummary {
  const sorted = [...measurement.durationsMs].sort((left, right) => left - right);
  return {
    requestedSamples,
    attemptedSamples: measurement.attemptedSamples,
    successes: measurement.successes,
    timeouts: measurement.timeouts,
    errors: measurement.errors,
    skippedSamples: measurement.skippedSamples,
    p50Ms: rounded(percentile(sorted, 50)),
    p95Ms: rounded(percentile(sorted, 95)),
    maxMs: rounded(sorted.length > 0 ? sorted[sorted.length - 1]! : null),
  };
}

function emptyMeasurement(): MutableMeasurement {
  return {
    durationsMs: [],
    attemptedSamples: 0,
    successes: 0,
    timeouts: 0,
    errors: 0,
    skippedSamples: 0,
  };
}

function isTimeout(error: unknown): boolean {
  if (error instanceof BeadsError) return error.kind === "timeout";
  if (!error || typeof error !== "object") return false;
  const candidate = error as { kind?: unknown; code?: unknown };
  return candidate.kind === "timeout" || candidate.code === "ETIMEDOUT";
}

async function measure<T>(
  target: MutableMeasurement,
  now: () => number,
  action: () => Promise<T>,
  validate: (value: T) => boolean = () => true,
): Promise<T | undefined> {
  target.attemptedSamples += 1;
  const startedAt = now();
  try {
    const value = await action();
    const durationMs = Math.max(0, now() - startedAt);
    if (!validate(value)) {
      target.errors += 1;
      return undefined;
    }
    target.successes += 1;
    target.durationsMs.push(durationMs);
    return value;
  } catch (error) {
    void now();
    if (isTimeout(error)) target.timeouts += 1;
    else target.errors += 1;
    return undefined;
  }
}

export async function runTaskHydrationBenchmark(
  args: BenchmarkArguments,
  dependencies: BenchmarkDependencies = productionDependencies,
): Promise<TaskHydrationBenchmarkResult> {
  const listMeasurement = emptyMeasurement();
  const hydrationMeasurements = new Map(args.hydrationCounts.map((count) => [count, emptyMeasurement()]));

  for (let sample = 0; sample < args.samples; sample += 1) {
    const taskIds = await measure(listMeasurement, dependencies.now, () => dependencies.list(args.teamName));
    for (const taskCount of args.hydrationCounts) {
      const target = hydrationMeasurements.get(taskCount)!;
      if (!taskIds || taskIds.length < taskCount) {
        target.skippedSamples += 1;
        continue;
      }
      const selectedIds = taskIds.slice(0, taskCount);
      await measure(
        target,
        dependencies.now,
        () => dependencies.hydrate(args.teamName, selectedIds),
        (hydrated) => hydrated.length === taskCount && hydrated.every((record) => record != null),
      );
    }
  }

  const teamScopedList = summarizeMeasurement(listMeasurement, args.samples);
  const exactBatchHydration = args.hydrationCounts.map((taskCount) => ({
    taskCount,
    ...summarizeMeasurement(hydrationMeasurements.get(taskCount)!, args.samples),
  }));
  const complete = teamScopedList.successes === args.samples
    && exactBatchHydration.every((measurement) => measurement.successes === args.samples);

  return {
    schema: TASK_HYDRATION_BENCHMARK_SCHEMA,
    status: complete ? "complete" : "partial",
    productionTimeoutMs: DEFAULT_BD_TIMEOUT_MS,
    workload: {
      samples: args.samples,
      hydrationCounts: [...args.hydrationCounts],
    },
    measurements: {
      teamScopedList,
      exactBatchHydration,
    },
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseBenchmarkArguments(argv);
  const result = await runTaskHydrationBenchmark(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "partial") process.exitCode = 2;
}

if (typeof require !== "undefined" && require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`Task hydration benchmark failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
