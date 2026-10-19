#!/usr/bin/env node
const { spawn: nodeSpawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const causalPath = "src/utils/causal-path-characterization.test.ts";
const causalTimeoutMs = 180_000;
const causalInventoryTitle = "keeps the Task-to-observation path and its outside-in anchors machine-operable";
const campaignPath = "sim/v31-campaign.test.ts";
// Approximate seconds per file on a CI runner, including Vitest startup. They
// only balance shards; correctness never depends on them.
const defaultCostSeconds = 3;
const costHintsSeconds = {
  [campaignPath]: 560,
  "sim/membership-conformance.test.ts": 24,
  "sim/campaign.test.ts": 16,
  "src/utils/formal-hardening-public-recovery.test.ts": 12,
};
const campaignStartupSeconds = 2;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function terminateProcessGroup(pid, signal) {
  // `detached` creates a new process group on POSIX, which lets one signal
  // reach Vitest and every process it starts.
  if (process.platform === "win32") return process.kill(pid, signal);
  return process.kill(-pid, signal);
}

function listTestFiles(directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".git" ? [] : listTestFiles(file);
    return /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [path.relative(root, file).replaceAll(path.sep, "/")] : [];
  }).sort();
}

function nonCausalFiles(config) {
  if (path.basename(config) === "vitest.exhaustive.config.ts") {
    const { exhaustiveOnly } = JSON.parse(fs.readFileSync(path.join(root, "test-lanes.json"), "utf8"));
    return exhaustiveOnly.filter((file) => file !== causalPath);
  }
  return listTestFiles().filter((file) => file !== causalPath);
}

function createExhaustiveRunner({
  spawn = nodeSpawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  terminateGroup = terminateProcessGroup,
} = {}) {
  function run(config, args, timeoutMs, env) {
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let deadlineError;
      let settled = false;

      const settle = (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimer(timer);
        if (error) reject(error);
        else resolve();
      };

      try {
        child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", config, ...args], {
          cwd: root,
          ...(env ? { env: { ...process.env, ...env } } : {}),
          detached: true,
          stdio: "inherit",
        });
      } catch (error) {
        settle(error);
        return;
      }

      child.once("error", (error) => {
        if (!deadlineError) settle(error);
      });
      child.once("close", (code, signal) => {
        if (deadlineError) return settle(deadlineError);
        if (code === 0 && signal == null) return settle();
        settle(new Error(`vitest closed with ${signal ?? `code ${code}`}`));
      });

      if (timeoutMs) {
        timer = setTimer(() => {
          deadlineError = new Error(`causal-path test exceeded ${timeoutMs / 1000} seconds`);
          try {
            terminateGroup(child.pid, "SIGTERM");
          } catch (error) {
            deadlineError = new Error(`${deadlineError.message}; process-group cleanup failed: ${errorMessage(error)}`);
          }
        }, timeoutMs);
      }
    });
  }

  return {
    async runNonCausal(config, files) {
      for (const file of files) await run(config, [file]);
    },
    /** Lanes run concurrently; units inside a lane run in order, one Vitest process each. */
    async runLanes(config, lanes) {
      let failed = false;
      await Promise.all(lanes.map(async (lane) => {
        for (const unit of lane) {
          if (failed) return;
          try {
            await run(config, [unit.file], undefined, unit.env);
          } catch (error) {
            failed = true;
            throw new Error(`${unit.label}: ${errorMessage(error)}`);
          }
        }
      }));
    },
    async runCausal(config, cases = [causalInventoryTitle]) {
      if (cases.length === 0) throw new Error("causal lane has no active test targets");
      for (const title of cases) {
        const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-causal-report-"));
        const reportFile = path.join(reportDir, "result.json");
        console.log(`causal case: ${title}`);
        try {
          await run(config, [causalPath, "-t", title, "--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`], causalTimeoutMs);
          let report;
          try {
            report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
          } catch (error) {
            throw new Error(`causal case ${title} has no valid Vitest JSON report: ${errorMessage(error)}`);
          }
          if (!report || !Number.isInteger(report.numPassedTests) || report.numPassedTests < 1) {
            throw new Error(`causal case ${title} executed no passing tests`);
          }
        } finally {
          fs.rmSync(reportDir, { recursive: true, force: true });
        }
      }
    },
  };
}

function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`--shard must be k/N with 1 <= k <= N, got ${value}`);
  return { index: Number(match[1]), count: Number(match[2]) };
}

/**
 * Deterministic partition of the exhaustive lane across `count` machines with
 * `lanesPerShard` concurrent processes each. Whole files are packed into some
 * lanes; the campaign splits into independent PI_SIM_CAMPAIGN_SHARD slices, one
 * per remaining lane, choosing the split that minimizes the slowest lane.
 * Every shard computes the same plan, and their union is the unsharded lane.
 */
function planShard(files, { index, count }, lanesPerShard) {
  const laneCount = count * lanesPerShard;
  const cost = (file) => costHintsSeconds[file] ?? defaultCostSeconds;
  const whole = files.filter((file) => file !== campaignPath).map((file, order) => ({ file, label: file, cost: cost(file), order }))
    .sort((a, b) => b.cost - a.cost || a.order - b.order);
  const hasCampaign = files.includes(campaignPath);
  const pack = (laneTotal) => {
    const loads = Array.from({ length: laneTotal }, () => 0);
    const lanes = loads.map(() => []);
    for (const unit of whole) {
      const target = loads.indexOf(Math.min(...loads));
      loads[target] += unit.cost;
      lanes[target].push(unit);
    }
    return { lanes, slowest: Math.max(0, ...loads) };
  };
  let best;
  for (let fileLanes = hasCampaign ? 0 : laneCount; fileLanes <= laneCount; fileLanes++) {
    const parts = hasCampaign ? laneCount - fileLanes : 0;
    if (hasCampaign && parts === 0) break;
    if (whole.length > 0 && fileLanes === 0) continue;
    const packed = pack(fileLanes);
    const slowest = Math.max(packed.slowest, parts ? cost(campaignPath) / parts + campaignStartupSeconds : 0);
    if (!best || slowest < best.slowest) best = { ...packed, parts, slowest };
  }
  const campaignLanes = Array.from({ length: best.parts }, (_, part) => [{
    file: campaignPath,
    label: `${campaignPath} [campaign shard ${part + 1}/${best.parts}]`,
    env: { PI_SIM_CAMPAIGN_SHARD: `${part + 1}/${best.parts}` },
  }]);
  return [...campaignLanes, ...best.lanes]
    .slice((index - 1) * lanesPerShard, index * lanesPerShard)
    .filter((lane) => lane.length > 0);
}

async function runExhaustiveTests(
  config,
  runner = createExhaustiveRunner(),
  files = nonCausalFiles(config),
  causalCases,
  shard,
  lanesPerShard = 4,
) {
  if (!shard) {
    await runner.runNonCausal(config, files);
    await runner.runCausal(config, causalCases);
    return;
  }
  await runner.runLanes(config, planShard(files, shard, lanesPerShard));
  // The causal lane keeps its own deadline and runs alone after the pool.
  if (shard.index === 1) await runner.runCausal(config, causalCases);
}

if (require.main === module) {
  const [config, ...flags] = process.argv.slice(2);
  const shardFlag = flags.find((flag) => flag.startsWith("--shard="));
  const lanesFlag = flags.find((flag) => flag.startsWith("--lanes="));
  const lanes = lanesFlag ? Number(lanesFlag.slice("--lanes=".length)) : undefined;
  if (!config || flags.some((flag) => flag !== shardFlag && flag !== lanesFlag) || (lanesFlag && !(Number.isInteger(lanes) && lanes > 0) || (lanesFlag && !shardFlag))) {
    throw new Error("usage: run-exhaustive-tests.cjs <vitest-config> [--shard=k/N [--lanes=L]]");
  }
  // Every shard must use the same --lanes value: it is part of the partition.
  runExhaustiveTests(config, undefined, undefined, undefined, shardFlag && parseShard(shardFlag.slice("--shard=".length)), lanes).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { campaignPath, causalInventoryTitle, causalPath, causalTimeoutMs, createExhaustiveRunner, listTestFiles, nonCausalFiles, parseShard, planShard, runExhaustiveTests, terminateProcessGroup };
