#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const mode = argv.shift() ?? "rpc";
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const samples = Number(value("samples", "7"));
const cwd = resolve(value("cwd", process.cwd()));
const extension = resolve(value("extension", join(cwd, "extensions", "index.ts")));
const pi = value("pi", "pi");

if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
  throw new Error("--samples must be an integer from 1 through 100");
}

function summarize(values, includeSamples = true) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return { n: 0 };
  const quantile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
  return {
    n: sorted.length,
    min_ms: Number(sorted[0].toFixed(2)),
    p50_ms: Number(quantile(0.5).toFixed(2)),
    p95_ms: Number(quantile(0.95).toFixed(2)),
    max_ms: Number(sorted.at(-1).toFixed(2)),
    ...(includeSamples ? { samples_ms: values.map((item) => Number(item.toFixed(2))) } : {}),
  };
}

function rpcProcess(args, environment = {}) {
  const child = spawn(pi, args, {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  let sequence = 0;
  const pending = new Map();

  child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    while (true) {
      const newline = output.indexOf("\n");
      if (newline === -1) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== "response" || !pending.has(record.id)) continue;
      pending.get(record.id)(record);
      pending.delete(record.id);
    }
  });

  return {
    child,
    error: () => errorOutput.slice(-1000),
    command(type) {
      return new Promise((accept, reject) => {
        const id = `benchmark-${++sequence}`;
        const started = performance.now();
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Pi RPC command timed out. ${errorOutput.slice(-1000)}`));
        }, 15_000);
        pending.set(id, (record) => {
          clearTimeout(timeout);
          if (!record.success) reject(new Error(`Pi RPC command failed: ${record.error ?? "unknown error"}`));
          else accept({ elapsedMs: performance.now() - started, record });
        });
        child.stdin.write(`${JSON.stringify({ id, type })}\n`);
      });
    },
  };
}

async function oneRpcStartup(args, environment) {
  const started = performance.now();
  const process = rpcProcess(args, environment);
  try {
    await process.command("get_state");
    return performance.now() - started;
  } finally {
    process.child.kill("SIGTERM");
  }
}

async function rpcBenchmark() {
  const base = ["--mode", "rpc", "--no-session", "--approve"];
  const exclusions = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
  const cases = [
    { name: "configured", args: base, environment: {} },
    { name: "configured_offline", args: base, environment: { PI_OFFLINE: "1" } },
    { name: "minimal_offline", args: [...base, ...exclusions], environment: { PI_OFFLINE: "1" } },
    {
      name: "exact_extension_offline",
      args: [...base, "--no-extensions", "-e", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
      environment: { PI_OFFLINE: "1", PI_TEAM_BRIGHT_SHIPPED_EXTENSION: extension },
    },
  ];
  const result = {};
  for (const item of cases) {
    const values = [];
    for (let index = 0; index < samples; index += 1) values.push(await oneRpcStartup(item.args, item.environment));
    result[item.name] = summarize(values);
  }
  return { kind: "pi_rpc_startup", samples, pi: basename(pi), result };
}

async function warmRpcBenchmark() {
  const process = rpcProcess([
    "--mode", "rpc", "--no-session", "--approve", "--no-extensions", "-e", extension,
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  ], { PI_OFFLINE: "1", PI_TEAM_BRIGHT_SHIPPED_EXTENSION: extension });
  try {
    const initial = await process.command("get_state");
    const replacements = [];
    for (let index = 0; index < samples; index += 1) {
      replacements.push((await process.command("new_session")).elapsedMs);
    }
    return {
      kind: "pi_warm_rpc_session_replacement",
      initial_ready_ms: Number(initial.elapsedMs.toFixed(2)),
      replacement: summarize(replacements),
    };
  } finally {
    process.child.kill("SIGTERM");
  }
}

function filesUnder(directory, target, output = []) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) filesUnder(path, target, output);
    else if (entry.name === target) output.push(path);
  }
  return output;
}

function historyBenchmark() {
  const teamsDirectory = resolve(value("teams-dir", join(homedir(), ".pi", "teams")));
  const durations = [];
  let prepared = 0;
  let sessionBound = 0;
  for (const file of filesUnder(teamsDirectory, "team-events.jsonl")) {
    const starts = new Map();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== "worker" || !record.membershipId || !record.at) continue;
      if (record.phase === "prepared") {
        prepared += 1;
        starts.set(record.membershipId, Date.parse(record.at));
      } else if (record.phase === "session_bound") {
        sessionBound += 1;
        const start = starts.get(record.membershipId);
        const end = Date.parse(record.at);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          durations.push({ elapsedMs: end - start, day: new Date(end).toISOString().slice(0, 10) });
          starts.delete(record.membershipId);
        }
      }
    }
  }
  const latestDay = durations.map((item) => item.day).sort().at(-1);
  return {
    kind: "durable_worker_prepared_to_session_bound",
    prepared_events: prepared,
    session_bound_events: sessionBound,
    matched: durations.length,
    all: summarize(durations.map((item) => item.elapsedMs), false),
    latest_day: latestDay,
    latest_day_result: summarize(durations.filter((item) => item.day === latestDay).map((item) => item.elapsedMs), false),
  };
}

function herdrCommand(args, timeout = 40_000) {
  const result = spawnSync("herdr", args, { encoding: "utf8", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `herdr exited ${result.status}`);
  return JSON.parse(result.stdout);
}

function herdrBenchmark() {
  const leaderPane = value("leader-pane");
  const agentDir = value("agent-dir");
  if (!leaderPane || !agentDir) {
    throw new Error("herdr mode requires explicit --leader-pane and --agent-dir values");
  }
  const cases = [
    { name: "minimal", args: ["--approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"] },
    { name: "exact_extension", args: ["--approve", "--no-extensions", "-e", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"] },
  ];
  const result = {};
  let sequence = 0;
  for (const item of cases) {
    const splitValues = [];
    const startValues = [];
    for (let index = 0; index < samples; index += 1) {
      const splitStarted = performance.now();
      const split = herdrCommand([
        "pane", "split", "--pane", leaderPane, "--direction", "right", "--ratio", "0.5", "--cwd", cwd,
        "--env", `PI_CODING_AGENT_DIR=${resolve(agentDir)}`, "--env", "PI_OFFLINE=1",
        "--env", `PI_TEAM_BRIGHT_SHIPPED_EXTENSION=${extension}`, "--no-focus",
      ]);
      splitValues.push(performance.now() - splitStarted);
      const pane = split.result?.pane?.pane_id;
      if (!pane) throw new Error("Herdr pane split returned no pane ID");
      try {
        const name = `ptb-startup-${process.pid}-${++sequence}`.slice(0, 32);
        const start = performance.now();
        herdrCommand(["agent", "start", name, "--kind", "pi", "--pane", pane, "--timeout", "10000", "--", ...item.args]);
        startValues.push(performance.now() - start);
      } finally {
        herdrCommand(["pane", "close", pane]);
      }
    }
    result[item.name] = { split: summarize(splitValues), agent_start: summarize(startValues) };
  }
  return { kind: "herdr_managed_pi_startup", samples, result };
}

let result;
if (mode === "rpc") result = await rpcBenchmark();
else if (mode === "warm-rpc") result = await warmRpcBenchmark();
else if (mode === "history") result = historyBenchmark();
else if (mode === "herdr") result = herdrBenchmark();
else throw new Error("mode must be rpc, warm-rpc, history, or herdr");

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
