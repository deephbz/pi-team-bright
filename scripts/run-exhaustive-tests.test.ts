import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const { causalInventoryTitle, causalPath, createExhaustiveRunner, runExhaustiveTests } = require("./run-exhaustive-tests.cjs");

class Child extends EventEmitter {
  constructor(readonly pid = 4123) { super(); }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function completeCausal(spawn: ReturnType<typeof vi.fn>, index: number, child: Child, report: unknown = { numPassedTests: 1 }): void {
  const outputArg = spawn.mock.calls[index][1].find((arg: string) => arg.startsWith("--outputFile.json="));
  expect(outputArg).toBeDefined();
  fs.writeFileSync(outputArg.slice("--outputFile.json=".length), JSON.stringify(report));
  child.emit("close", 0, null);
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
  it("runs each non-causal file in order before the causal lane", async () => {
    const first = new Child(1);
    const second = new Child(2);
    const causal = new Child(3);
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(causal);
    const runner = createExhaustiveRunner({ spawn });
    const running = runExhaustiveTests("vitest.test.config.ts", runner, ["first.test.ts", "second.test.ts"], [causalInventoryTitle]);

    expect(spawn.mock.calls[0][1]).toContain("first.test.ts");
    first.emit("close", 0, null);
    await nextTurn();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).toContain("second.test.ts");
    second.emit("close", 0, null);
    await nextTurn();
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[2][1]).toContain(causalPath);
    completeCausal(spawn, 2, causal);
    await expect(running).resolves.toBeUndefined();
  });

  it("runs explicit causal targets independently with an observable case title", async () => {
    const inventory = new Child(1);
    const scenario = new Child(2);
    const spawn = vi.fn().mockReturnValueOnce(inventory).mockReturnValueOnce(scenario);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runner = createExhaustiveRunner({ spawn });
    const running = runner.runCausal("vitest.test.config.ts", ["inventory", "second target"]);

    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining([causalPath, "-t", "inventory"]));
    expect(output).toHaveBeenCalledWith("causal case: inventory");
    completeCausal(spawn, 0, inventory);
    await nextTurn();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).toEqual(expect.arrayContaining([causalPath, "-t", "second target"]));
    expect(output).toHaveBeenCalledWith("causal case: second target");
    completeCausal(spawn, 1, scenario);
    await expect(running).resolves.toBeUndefined();
  });

  it("defaults to the one active causal inventory test", async () => {
    const child = new Child();
    const spawn = vi.fn(() => child);
    const running = createExhaustiveRunner({ spawn }).runCausal("vitest.test.config.ts");

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining([causalPath, "-t", causalInventoryTitle]));
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["--reporter=default", "--reporter=json"]));
    completeCausal(spawn, 0, child);
    await expect(running).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty causal target list", async () => {
    const spawn = vi.fn();
    await expect(createExhaustiveRunner({ spawn }).runCausal("vitest.test.config.ts", [])).rejects.toThrow("no active test targets");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["zero-pass", { numPassedTests: 0 }, "executed no passing tests"],
    ["malformed", "not JSON", "no valid Vitest JSON report"],
    ["missing", undefined, "no valid Vitest JSON report"],
  ])("fails closed for a %s targeted causal report", async (_kind, report, message) => {
    const child = new Child();
    const spawn = vi.fn(() => child);
    const running = createExhaustiveRunner({ spawn }).runCausal("vitest.test.config.ts", [causalInventoryTitle]);
    const outputArg = spawn.mock.calls[0][1].find((arg: string) => arg.startsWith("--outputFile.json="));
    expect(outputArg).toBeDefined();
    const reportFile = outputArg.slice("--outputFile.json=".length);
    if (report !== undefined) fs.writeFileSync(reportFile, report === "not JSON" ? report : JSON.stringify(report));
    child.emit("close", 0, null);
    await expect(running).rejects.toThrow(message);
    expect(fs.existsSync(path.dirname(reportFile))).toBe(false);
  });

  it("short-circuits causal scenarios after a failure", async () => {
    const child = new Child();
    const spawn = vi.fn(() => child);
    const runner = createExhaustiveRunner({ spawn });
    const running = runner.runCausal("vitest.test.config.ts", ["first scenario", "second scenario"]);

    child.emit("close", 1, null);
    await expect(running).rejects.toThrow("vitest closed with code 1");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("short-circuits remaining files and the causal lane after a non-causal failure", async () => {
    const child = new Child();
    const spawn = vi.fn(() => child);
    const runner = createExhaustiveRunner({ spawn });
    const running = runExhaustiveTests("vitest.test.config.ts", runner, ["first.test.ts", "second.test.ts"]);

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
    const running = runner.runNonCausal("vitest.test.config.ts", ["example.test.ts"]);

    child.emit("close", code, signal);
    await expect(running).rejects.toThrow(message);
  });

  it("propagates spawn failures", async () => {
    const child = new Child();
    const runner = createExhaustiveRunner({ spawn: () => child });
    const running = runner.runNonCausal("vitest.test.config.ts", ["example.test.ts"]);

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
    const running = runner.runCausal("vitest.test.config.ts", [causalInventoryTitle]);

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
    let deadline!: () => void;
    const runner = createExhaustiveRunner({
      spawn: () => {
        const child = spawnChild(process.execPath, [path.resolve("scripts/fixtures/exhaustive-runner-descendant.cjs"), pidFile], {
          detached: true,
          stdio: "ignore",
        });
        groupPid = child.pid;
        return child;
      },
      setTimer: (callback: () => void) => { deadline = callback; return 1 as any; },
      clearTimer: () => {},
    });

    try {
      const running = runner.runCausal("vitest.test.config.ts", [causalInventoryTitle]);
      await waitForFile(pidFile);
      const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
      deadline();
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
