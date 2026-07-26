import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bdExecFailure, defaultBdRunner, OwnedBdBinaryError, resolveBdExecutable } from "./beads";

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  vi.restoreAllMocks();
});

describe("owned Beads CLI", () => {
  it("runs the package-local bd when PATH excludes node_modules/.bin", async () => {
    const executable = resolveBdExecutable();
    expect(executable).toContain(`${path.sep}@beads${path.sep}bd${path.sep}`);

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
