#!/usr/bin/env node
const { spawn: nodeSpawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const causalPath = "src/utils/causal-path-characterization.test.ts";
const causalTimeoutMs = 180_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function terminateProcessGroup(pid, signal) {
  // `detached` creates a new process group on POSIX, which lets one signal
  // reach Vitest and every process it starts.
  if (process.platform === "win32") return process.kill(pid, signal);
  return process.kill(-pid, signal);
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
    runNonCausal(config) {
      return run(config, ["--exclude", causalPath]);
    },
    runCausal(config) {
      return run(config, [causalPath], causalTimeoutMs);
    },
  };
}

async function runExhaustiveTests(config, runner = createExhaustiveRunner()) {
  await runner.runNonCausal(config);
  await runner.runCausal(config);
}

if (require.main === module) {
  const config = process.argv[2];
  if (!config) throw new Error("usage: run-exhaustive-tests.cjs <vitest-config>");
  runExhaustiveTests(config).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { causalPath, causalTimeoutMs, createExhaustiveRunner, runExhaustiveTests, terminateProcessGroup };
