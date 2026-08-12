import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const { causalPath, createExhaustiveRunner, runExhaustiveTests } = require("./run-exhaustive-tests.cjs");

class Child extends EventEmitter {
  constructor(readonly pid = 4123) { super(); }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture did not create ${file}`);
}

async function waitForDead(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error: any) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`orphaned descendant ${pid}`);
}

describe("exhaustive test runner", () => {
  it("runs the non-causal lane before the causal lane", async () => {
    const first = new Child(1);
    const second = new Child(2);
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const runner = createExhaustiveRunner({ spawn });
    const running = runExhaustiveTests("vitest.test.config.ts", runner);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toContain("--exclude");
    expect(spawn.mock.calls[0][1]).toContain(causalPath);
    first.emit("close", 0, null);
    await nextTurn();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).not.toContain("--exclude");
    expect(spawn.mock.calls[1][1]).toContain(causalPath);
    second.emit("close", 0, null);
    await expect(running).resolves.toBeUndefined();
  });

  it("does not start the causal lane after the non-causal lane fails", async () => {
    const child = new Child();
    const spawn = vi.fn(() => child);
    const runner = createExhaustiveRunner({ spawn });
    const running = runExhaustiveTests("vitest.test.config.ts", runner);

    child.emit("close", 1, null);
    await expect(running).rejects.toThrow("vitest closed with code 1");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["exit", 2, null, "vitest closed with code 2"],
    ["signal", null, "SIGKILL", "vitest closed with SIGKILL"],
  ])("propagates a Vitest %s failure", async (_kind, code, signal, message) => {
    const child = new Child();
    const runner = createExhaustiveRunner({ spawn: () => child });
    const running = runner.runNonCausal("vitest.test.config.ts");

    child.emit("close", code, signal);
    await expect(running).rejects.toThrow(message);
  });

  it("propagates spawn failures", async () => {
    const child = new Child();
    const runner = createExhaustiveRunner({ spawn: () => child });
    const running = runner.runNonCausal("vitest.test.config.ts");

    child.emit("error", new Error("spawn unavailable"));
    await expect(running).rejects.toThrow("spawn unavailable");
  });

  it("terminates the detached group on deadline, reaps it, and settles once", async () => {
    const child = new Child(9876);
    let deadline!: () => void;
    const terminateGroup = vi.fn();
    const runner = createExhaustiveRunner({
      spawn: () => child,
      setTimer: (callback: () => void) => { deadline = callback; return 1 as any; },
      clearTimer: () => {},
      terminateGroup,
    });
    const running = runner.runCausal("vitest.test.config.ts");

    deadline();
    expect(terminateGroup).toHaveBeenCalledOnce();
    expect(terminateGroup).toHaveBeenCalledWith(9876, "SIGTERM");
    let settled = 0;
    void running.catch(() => { settled += 1; });
    await nextTurn();
    expect(settled).toBe(0);
    child.emit("error", new Error("late spawn error"));
    child.emit("close", null, "SIGTERM");
    await expect(running).rejects.toThrow("causal-path test exceeded 180 seconds");
    await nextTurn();
    expect(settled).toBe(1);
  });

  it("leaves no descendant after deadline cleanup", async () => {
    if (process.platform === "win32") return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustive-runner-"));
    const pidFile = path.join(directory, "descendant.pid");
    let groupPid: number | undefined;
    const runner = createExhaustiveRunner({
      spawn: () => {
        const child = spawnChild(process.execPath, [path.resolve("scripts/fixtures/exhaustive-runner-descendant.cjs"), pidFile], {
          detached: true,
          stdio: "ignore",
        });
        groupPid = child.pid;
        return child;
      },
      setTimer: (callback: () => void) => setTimeout(callback, 80),
    });

    try {
      const running = runner.runCausal("vitest.test.config.ts");
      await waitForFile(pidFile);
      const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
      await expect(running).rejects.toThrow("causal-path test exceeded");
      await waitForDead(descendantPid);
    } finally {
      if (groupPid) {
        try { process.kill(-groupPid, "SIGKILL"); } catch { /* group already reaped */ }
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

afterEach(() => vi.restoreAllMocks());
