import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bdExecFailure, defaultBdRunner, ExecBdRunner, OwnedBdBinaryError, resolveBdExecutable } from "./beads";
import { withSemanticTrace } from "./trace";

const originalPath = process.env.PATH;
const originalTrace = process.env.PI_TEAMS_TRACE_JSONL;
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalTrace === undefined) delete process.env.PI_TEAMS_TRACE_JSONL;
  else process.env.PI_TEAMS_TRACE_JSONL = originalTrace;
  vi.restoreAllMocks();
});

describe("owned Beads CLI", () => {
  it("runs the package-local bd when PATH excludes node_modules/.bin", async () => {
    const executable = resolveBdExecutable();
    expect(executable).toContain(`${path.sep}@beads${path.sep}bd${path.sep}bin${path.sep}bd`);

    // Keep Node available for the package bin's env shebang but remove every
    // package bin directory and any ambient bd executable from command lookup.
    process.env.PATH = path.dirname(process.execPath);
    const result = await defaultBdRunner.run(["--version"], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^bd version 1\.1\.0\b/m);
  });

  it("settles at its wall-clock deadline and removes a stdio-holding descendant", async () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-bd-runner-"));
    const pidFile = path.join(root, "descendant.pid");
    const traceFile = path.join(root, "trace.jsonl");
    process.env.PI_TEAMS_TRACE_JSONL = traceFile;
    const fixture = path.join(process.cwd(), "src", "utils", "fixtures", "bd-runner-stdio-descendant.cjs");
    const runner = new ExecBdRunner(() => process.execPath);
    const startedAt = Date.now();
    const result = await withSemanticTrace("bd-runner-timeout", {}, () => runner.run([fixture, pidFile], { cwd: root, timeoutMs: 100 }));
    const elapsedMs = Date.now() - startedAt;
    const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));

    expect(result).toMatchObject({ exitCode: 124, stdout: "", stderr: "" });
    expect(elapsedMs).toBeGreaterThanOrEqual(80);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(() => process.kill(descendantPid, 0)).toThrow();
    const trace = JSON.parse(fs.readFileSync(traceFile, "utf8"));
    expect(trace.bdRunnerLifecycle.map((entry: { event: string }) => entry.event)).toEqual([
      "start", "deadline", "termination_cleanup", "settled",
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the prior 8 MiB combined output limit", async () => {
    const runner = new ExecBdRunner(() => process.execPath);
    const result = await runner.run(["-e", "process.stdout.write('x'.repeat(9 * 1024 * 1024)); setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
    });

    expect(result.exitCode).toBe(1);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("converts package manifest read failures into typed unavailable bd results", async () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("manifest read denied");
    });

    expect(() => resolveBdExecutable()).toThrow(OwnedBdBinaryError);
    const result = await defaultBdRunner.run(["--version"], { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toMatch(/^bd: unable to resolve owned @beads\/bd launcher; reinstall @beads\/bd@1\.1\.0 \(manifest read denied\)$/);
  });

  it("reports a missing owned binary as an unavailable bd command", () => {
    const result = bdExecFailure(new OwnedBdBinaryError(
      "BEADS_OWNED_BINARY_MISSING",
      "owned @beads/bd binary is missing for linux-x64",
    ));

    expect(result).toEqual({
      stdout: "",
      stderr: "bd: owned @beads/bd binary is missing for linux-x64",
      exitCode: 127,
    });
  });
});
