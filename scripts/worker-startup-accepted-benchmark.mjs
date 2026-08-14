#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const samples = Number(option("samples", "5"));
const leaderPane = option("leader-pane");
const agentDir = option("agent-dir");
const cwd = resolve(option("cwd", process.cwd()));
const extension = resolve(option("extension", "extensions/index.ts"));
const herdr = option("herdr", process.env.HERDR_BIN_PATH || "herdr");

if (!leaderPane || !agentDir) throw new Error("--leader-pane and --agent-dir are required");
if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error("--samples must be an integer from 1 through 100");

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
  return {
    samples: sorted.length,
    min_ms: Number(sorted[0].toFixed(2)),
    p50_ms: Number(quantile(0.5).toFixed(2)),
    p95_ms: Number(quantile(0.95).toFixed(2)),
    max_ms: Number(sorted.at(-1).toFixed(2)),
    samples_ms: values.map((value) => Number(value.toFixed(2))),
  };
}

function command(args, timeout = 40_000) {
  const started = performance.now();
  const result = spawnSync(herdr, args, { encoding: "utf8", timeout });
  const elapsedMs = performance.now() - started;
  if (result.error) throw result.error;
  let response;
  try { response = JSON.parse(result.stdout); } catch { response = undefined; }
  if (result.status !== 0 || !response?.result) {
    throw new Error(result.stderr || result.stdout || `Herdr exited ${result.status}`);
  }
  return { response, elapsedMs };
}

function herdrVersion() {
  const result = spawnSync(herdr, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.stdout || "Could not read Herdr version.");
  return result.stdout.trim();
}

const retryWait = new Int32Array(new SharedArrayBuffer(4));

function acceptedStartCommand(args) {
  const started = performance.now();
  const deadline = started + 5_000;
  while (true) {
    try {
      const result = command(args);
      return { ...result, elapsedMs: performance.now() - started };
    } catch (error) {
      if (!(error instanceof Error) || !/agent_pane_busy/.test(error.message) || performance.now() >= deadline) throw error;
      Atomics.wait(retryWait, 0, 0, 50);
    }
  }
}

function acceptedAgent(response, expectedName, expectedPane) {
  const agent = response?.result?.agent;
  if (response?.result?.type !== "agent_started" || !agent || agent.name !== expectedName || agent.pane_id !== expectedPane) {
    throw new Error("Herdr accepted-start response did not prove the exact recognized agent and pane.");
  }
  if (agent.launch_pending !== true && agent.interactive_ready !== true) {
    throw new Error("Herdr accepted-start response did not prove pending or interactive agent state.");
  }
}

const cases = [
  {
    name: "minimal",
    piArgs: ["--approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
  },
  {
    name: "exact_extension",
    piArgs: ["--approve", "--no-extensions", "-e", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
  },
];

const result = {
  schema: "pi-team-bright-herdr-accepted-start/1",
  mode: "cold_owned_pane",
  samples_per_case: samples,
  command_contract: "herdr agent start --wait accepted --timeout 10000",
  herdr_version: herdrVersion(),
  cases: {},
};
let sequence = 0;
for (const item of cases) {
  const split = [];
  const accepted = [];
  const cleanup = [];
  for (let index = 0; index < samples; index += 1) {
    const splitResult = command([
      "pane", "split", "--pane", leaderPane, "--direction", "right", "--ratio", "0.5", "--cwd", cwd,
      "--env", `PI_CODING_AGENT_DIR=${resolve(agentDir)}`,
      "--env", "PI_OFFLINE=1",
      "--env", `PI_TEAM_BRIGHT_SHIPPED_EXTENSION=${extension}`,
      "--no-focus",
    ]);
    split.push(splitResult.elapsedMs);
    const paneId = splitResult.response.result?.pane?.pane_id;
    if (!paneId) throw new Error("Herdr pane split returned no pane ID");
    const name = `ptbfast-${process.pid}-${++sequence}`.slice(0, 32);
    try {
      const startResult = acceptedStartCommand([
        "agent", "start", name, "--kind", "pi", "--pane", paneId,
        "--wait", "accepted", "--timeout", "10000", "--", ...item.piArgs,
      ]);
      acceptedAgent(startResult.response, name, paneId);
      accepted.push(startResult.elapsedMs);
    } finally {
      const closed = command(["pane", "close", paneId]);
      cleanup.push(closed.elapsedMs);
      const agents = command(["agent", "list"]).response.result?.agents;
      if (!Array.isArray(agents) || agents.some((agent) => agent?.name === name || agent?.pane_id === paneId)) {
        throw new Error("Herdr cleanup left the accepted recognized agent or its pane visible.");
      }
    }
  }
  result.cases[item.name] = { pane_split: summarize(split), agent_start_accepted: summarize(accepted), cleanup: summarize(cleanup) };
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
