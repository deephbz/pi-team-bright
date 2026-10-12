import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { resolveBdExecutable, readBeadsAuthorityFingerprint } from "../src/utils/beads";
import { emptyBdWire } from "./bd-wire";

it("matches owned bd 1.1.0 for the empty-store command sequence used by real Team startup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sim-bd-conformance-"));
  const binary = resolveBdExecutable();
  expect(execFileSync(binary, ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).toMatch(/1\.1\.0/);
  const real = path.join(root, "real", "workspace");
  const fake = path.join(root, "fake", "workspace");
  for (const workspace of [real, fake]) {
    fs.mkdirSync(workspace, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: workspace });
  }
  const sequence = [
    ["init", "--quiet", "--non-interactive", "--skip-agents", "--skip-hooks", "--init-if-missing"],
    ["--json", "where"],
    ["--json", "list", "--label", "pi-teams:team-1", "--all", "--no-pager", "--limit", "0"],
    ["--json", "where"],
    ["--json", "list", "--label", "pi-teams:team-1", "--all", "--no-pager", "--limit", "0"],
  ];
  const normalize = (text: string, workspace: string) => {
    const replaced = text.trim().split(fs.realpathSync(workspace)).join("<workspace>").split(workspace).join("<workspace>");
    try { return JSON.parse(replaced); } catch { return replaced; }
  };
  try {
    for (const args of sequence) {
      const observed = spawnSync(binary, args[0] === "init" ? args : ["--directory", real, ...args], { cwd: real, encoding: "utf8", timeout: 30000 });
      const simulated = emptyBdWire(["--directory", fake, ...args]);
      expect({ status: simulated.status, stdout: normalize(simulated.stdout, fake), stderr: normalize(simulated.stderr, fake) })
        .toEqual({ status: observed.status, stdout: normalize(observed.stdout, real), stderr: normalize(observed.stderr, real) });
    }
    const normalizeFingerprint = (workspace: string) => {
      const { projectId, doltDatabase, ...stable } = readBeadsAuthorityFingerprint(workspace);
      expect(projectId.length).toBeGreaterThan(0);
      expect(doltDatabase.length).toBeGreaterThan(0);
      return stable;
    };
    expect(normalizeFingerprint(fake)).toEqual(normalizeFingerprint(real));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);
