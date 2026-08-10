import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readObservationSnapshot } from "../public/observation";
import { readMembershipObservation } from "./membership-observation-reader";

const roots: string[] = [];
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-membership-reader-")); roots.push(value); return value; }
function write(rootPath: string, relative: string, value: unknown): void { const file = path.join(rootPath, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); }
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

describe("Membership observation reader", () => {
  it("decodes ordered projection evidence and diagnoses without exposing private records", async () => {
    const teamsRoot = root();
    write(teamsRoot, "zeta/config.json", { name: "zeta", members: [{ membershipId: "worker-1", name: "worker", agentType: "teammate", joinedAt: 1_700_000_000_000, isActive: true, sessionFile: "relative.jsonl", model: "private" }, { membershipId: "bad", name: "bad member", agentType: "teammate", joinedAt: 1 }] });
    write(teamsRoot, "zeta/runtime/worker.json", { membershipId: "worker-1", pid: 99, startedAt: 1_700_000_000_001, ready: true, argv: ["private"] });
    write(teamsRoot, "alpha/config.json", { name: "alpha", members: [] });

    const read = await readMembershipObservation({ teamsRoot });
    expect(read).toEqual({ teams: [
      { teamName: "alpha", memberships: [], diagnoses: [] },
      { teamName: "zeta", memberships: [{ membershipId: "worker-1", memberName: "worker", coordinationRole: "teammate", lifecycle: { state: "current", joinedAt: "2023-11-14T22:13:20.000Z" }, processBinding: { membershipId: "worker-1", pid: 99, processStartedAt: "2023-11-14T22:13:20.001Z" }, readiness: true, diagnoses: ["session_locator_invalid"] }], diagnoses: ["membership_malformed"] },
    ], diagnoses: [] });
    expect(JSON.stringify(read)).not.toContain("private");
  });

  it("preserves truthy non-string runtime Membership IDs as generation mismatches", async () => {
    const teamsRoot = root();
    write(teamsRoot, "alpha/config.json", { name: "alpha", members: [{ membershipId: "number-id", name: "number", agentType: "teammate", joinedAt: 1_700_000_000_000, isActive: true }, { membershipId: "object-id", name: "object", agentType: "teammate", joinedAt: 1_700_000_000_000, isActive: true }] });
    write(teamsRoot, "alpha/runtime/number.json", { membershipId: 7, pid: 99, startedAt: 1_700_000_000_001 });
    write(teamsRoot, "alpha/runtime/object.json", { membershipId: { legacy: true }, pid: 100, startedAt: 1_700_000_000_001 });
    const snapshot = await readObservationSnapshot({ teamsRoot });
    expect(snapshot.teams[0].memberships.map(member => [member.memberName, member.issues.map(issue => issue.code), member.processBinding, member.readiness])).toEqual([
      ["number", ["runtime_generation_mismatch"], undefined, undefined],
      ["object", ["runtime_generation_mismatch"], undefined, undefined],
    ]);
  });

  it("preserves a truthy raw ended deactivation reason in the public JSON", async () => {
    const teamsRoot = root(); const reason = { legacy: "custom" };
    write(teamsRoot, "alpha/config.json", { name: "alpha", members: [{ membershipId: "worker-1", name: "worker", agentType: "teammate", joinedAt: 1_700_000_000_000, isActive: false, deactivationReason: reason }] });
    const snapshot = await readObservationSnapshot({ teamsRoot });
    expect(snapshot.teams[0].memberships[0]).toMatchObject({ lifecycle: { state: "ended", joinedAt: "2023-11-14T22:13:20.000Z", reason }, issues: [{ code: "runtime_missing", scope: "membership", teamName: "alpha", memberName: "worker", membershipId: "worker-1" }] });
    expect(JSON.parse(JSON.stringify(snapshot)).teams[0].memberships[0].lifecycle.reason).toEqual(reason);
  });

  it("keeps the public wire projection equivalent to reader evidence and diagnoses", async () => {
    const teamsRoot = root();
    write(teamsRoot, "alpha/config.json", { name: "alpha", members: [{ membershipId: "worker-1", name: "worker", agentType: "teammate", joinedAt: 1_700_000_000_000, isActive: true }] });
    const [read, snapshot] = await Promise.all([readMembershipObservation({ teamsRoot }), readObservationSnapshot({ teamsRoot, producerVersion: "equivalence" })]);
    expect(read.teams[0].memberships[0].diagnoses).toEqual(["runtime_missing"]);
    expect(snapshot).toMatchObject({ producerVersion: "equivalence", availability: "partial", teams: [{ teamName: "alpha", memberships: [{ membershipId: "worker-1", memberName: "worker", issues: [{ code: "runtime_missing", scope: "membership", teamName: "alpha", memberName: "worker", membershipId: "worker-1" }] }], issues: [] }], issues: [] });
  });

  it("keeps deadline, abort, and config/runtime/config generation boundaries in the reader", async () => {
    const teamsRoot = root();
    write(teamsRoot, "alpha/config.json", { name: "alpha", members: [{ membershipId: "worker-1", name: "worker", agentType: "teammate", joinedAt: 1_700_000_000_000, isActive: true }] });
    await expect(readMembershipObservation({ teamsRoot, deadlineMs: 0 })).resolves.toEqual({ teams: [], diagnoses: [{ code: "projection_deadline_exceeded" }] });
    const controller = new AbortController(); controller.abort();
    await expect(readMembershipObservation({ teamsRoot, signal: controller.signal })).resolves.toEqual({ teams: [], diagnoses: [{ code: "projection_aborted" }] });
    const configFile = path.join(teamsRoot, "alpha/config.json"); const original = fs.readFileSync; let reads = 0;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => file === configFile ? Buffer.from(`${original(file, ...args as [])}${" ".repeat(++reads)}`) : original(file, ...args as [])) as any);
    const raced = await readMembershipObservation({ teamsRoot }); spy.mockRestore();
    expect(raced).toEqual({ teams: [], diagnoses: [{ code: "team_changed_during_read", teamName: "alpha" }] });
  });

  it("keeps core independent from the public projector and public imports narrow", () => {
    const src = path.resolve(__dirname, "..");
    const production = fs.readdirSync(src, { recursive: true }).filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts") && !entry.endsWith(".test.ts"));
    for (const relative of production.filter(relative => !relative.startsWith("public/"))) expect(fs.readFileSync(path.join(src, relative), "utf8")).not.toMatch(/from ["'][^"']*public\/observation["']/);
    const observationSource = fs.readFileSync(path.join(src, "public/observation.ts"), "utf8");
    expect([...observationSource.matchAll(/^import .*? from "([^"]+)";/gm)].map(match => match[1])).toEqual(["../../package.json", "../team-authority/membership-observation-reader"]);
    const readerSource = fs.readFileSync(path.join(src, "team-authority/membership-observation-reader.ts"), "utf8");
    expect([...readerSource.matchAll(/^import .*? from "([^"]+)";/gm)].map(match => match[1])).toEqual(["node:fs", "node:os", "node:path"]);
  });
});
