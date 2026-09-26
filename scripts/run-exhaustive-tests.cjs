#!/usr/bin/env node
const { spawn: nodeSpawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const causalPath = "src/utils/causal-path-characterization.test.ts";
const causalTimeoutMs = 180_000;
const causalInventoryTitle = "keeps the Task-to-observation path and its outside-in anchors machine-operable";

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
  function run(config, args, timeoutMs) {
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

async function runExhaustiveTests(
  config,
  runner = createExhaustiveRunner(),
  files = nonCausalFiles(config),
  causalCases,
) {
  await runner.runNonCausal(config, files);
  await runner.runCausal(config, causalCases);
}

if (require.main === module) {
  const config = process.argv[2];
  if (!config) throw new Error("usage: run-exhaustive-tests.cjs <vitest-config>");
  runExhaustiveTests(config).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { causalInventoryTitle, causalPath, causalTimeoutMs, createExhaustiveRunner, listTestFiles, nonCausalFiles, runExhaustiveTests, terminateProcessGroup };
