#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const samplesIndex = argv.indexOf("--samples");
if (argv.some((value, index) => value.startsWith("--") && (value !== "--samples" || index !== samplesIndex))) {
  throw new Error("Only --samples is supported.");
}
const samples = samplesIndex === -1 ? 5 : Number(argv[samplesIndex + 1]);
if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
  throw new Error("--samples must be an integer from 1 through 100.");
}

function piModels() {
  const result = spawnSync("pi", ["--list-models"], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0 || !result.stdout) {
    throw new Error(`pi --list-models failed with status ${result.status ?? "unknown"}.`);
  }
  return result.stdout.split("\n").flatMap((line) => {
    const [provider, model] = line.trim().split(/\s+/, 3);
    if (!provider || !model || provider === "provider") return [];
    return [`${provider}/${model}`];
  });
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile) => sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)];
  return {
    samples: sorted.length,
    min_ms: Number(sorted[0].toFixed(4)),
    p50_ms: Number(at(0.5).toFixed(4)),
    p95_ms: Number(at(0.95).toFixed(4)),
    max_ms: Number(sorted.at(-1).toFixed(4)),
    samples_ms: values.map((value) => Number(value.toFixed(4))),
  };
}

const initialKeys = piModels();
const candidate = initialKeys.at(0);
if (!candidate) throw new Error("pi --list-models returned no qualified model key.");
const records = initialKeys.map((key) => {
  const separator = key.indexOf("/");
  return { provider: key.slice(0, separator), id: key.slice(separator + 1) };
});
const cliValidation = [];
const snapshotValidation = [];

for (let index = 0; index < samples; index += 1) {
  let started = performance.now();
  const listed = piModels();
  if (!listed.includes(candidate)) throw new Error("Pi catalog changed during CLI validation.");
  cliValidation.push(performance.now() - started);

  started = performance.now();
  const snapshot = new Set(records.map(({ provider, id }) => `${provider}/${id}`));
  if (!snapshot.has(candidate)) throw new Error("In-process snapshot did not retain the selected key.");
  snapshotValidation.push(performance.now() - started);
}

const version = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 10_000 });
process.stdout.write(`${JSON.stringify({
  schema: "pi-team-bright-worker-model-registry-benchmark/1",
  recorded_at: new Date().toISOString(),
  environment: {
    node_version: process.version,
    platform: process.platform,
    pi_version: version.status === 0 ? version.stdout.trim() : "unavailable",
  },
  workload: {
    samples_per_case: samples,
    candidate_source: "first qualified key from an initial pi --list-models result; key omitted from output",
    cli_validation: "exact pi --list-models parse and equality check",
    snapshot_validation: "in-process qualified-key Set construction and equality check",
  },
  measurements: {
    cli_default_model_validation: summarize(cliValidation),
    snapshot_capture_and_validation: summarize(snapshotValidation),
  },
  limits: [
    "The snapshot case measures the local set conversion used after the exact tool context already owns ModelRegistry; it does not refresh model availability.",
    "The CLI case measures the removed subprocess path and includes local Pi startup and catalog formatting.",
  ],
}, null, 2)}\n`);
