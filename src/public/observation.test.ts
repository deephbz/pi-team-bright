import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBSERVATION_PRODUCER_VERSION, OBSERVATION_SCHEMA, observationJsonSchema, readObservationSnapshot } from "./observation";

const roots: string[] = [];
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-observation-")); roots.push(value); return value; }
function write(rootPath: string, team: string, relative: string, value: unknown): void { const file = path.join(rootPath, team, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); }
function config(members: unknown[]) { return { name: "alpha", members }; }
const lead = { membershipId: "lead-1", name: "team-lead", agentType: "lead", joinedAt: 1_700_000_000_000, isActive: true, sessionFile: "/private/lead.jsonl", terminalTarget: { backend: "tmux", kind: "pane", targetId: "%1" } };
const teammate = { membershipId: "worker-1", name: "worker", agentType: "teammate", joinedAt: 1_700_000_000_000, isActive: true, sessionFile: "/private/worker.jsonl", terminalTarget: { backend: "herdr", kind: "window", targetId: "w1" } };
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

/** Small schema probe for the closed discriminated structures this package owns. */
function rejects(schema: any, value: any): boolean {
  if (schema.$ref) return rejects((observationJsonSchema.$defs as any)[schema.$ref.split("/").pop()!], value);
  if (schema.oneOf) return schema.oneOf.filter((branch: any) => !rejects(branch, value)).length !== 1;
  if (schema.const !== undefined) return value !== schema.const;
  if (schema.enum) return !schema.enum.includes(value);
  if (schema.type === "object") { if (!value || typeof value !== "object" || Array.isArray(value)) return true; if ((schema.required ?? []).some((key: string) => !(key in value))) return true; if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return true; return Object.entries(schema.properties ?? {}).some(([key, child]) => key in value && rejects(child, value[key])); }
  if (schema.type === "array") return !Array.isArray(value) || value.some(item => rejects(schema.items, item));
  if (schema.type === "string") return typeof value !== "string" || (schema.minLength && value.length < schema.minLength) || (schema.pattern && !(new RegExp(schema.pattern).test(value)));
  if (schema.type === "integer") return !Number.isInteger(value) || (schema.minimum !== undefined && value < schema.minimum);
  if (schema.type === "boolean") return typeof value !== "boolean";
  return false;
}

describe("pi-teams-observation/1", () => {
  it("projects lead and teammate runtime evidence with the package producer version", async () => {
    const teamsRoot = root(); write(teamsRoot, "alpha", "config.json", config([lead, teammate]));
    write(teamsRoot, "alpha", "runtime/team-lead.json", { membershipId: "lead-1", pid: 100, startedAt: 1_700_000_000_001, ready: true }); write(teamsRoot, "alpha", "runtime/worker.json", { membershipId: "worker-1", pid: 101, startedAt: 1_700_000_000_002, ready: false });
    const snapshot = await readObservationSnapshot({ teamsRoot });
    expect(snapshot.producerVersion).toBe(OBSERVATION_PRODUCER_VERSION); expect(snapshot.availability).toBe("available");
    expect(snapshot.teams[0].memberships).toMatchObject([{ membershipId: "lead-1", coordinationRole: "lead", processBinding: { membershipId: "lead-1", pid: 100 }, readiness: true }, { membershipId: "worker-1", coordinationRole: "teammate", processBinding: { membershipId: "worker-1", pid: 101 }, readiness: false }]);
    expect(JSON.stringify(snapshot)).not.toContain("config.json"); expect(JSON.stringify(snapshot)).not.toContain("runtime/");
  });

  it("closes schema variants and rejects empty lifecycle/session/process evidence and unknown issues", () => {
    const defs: any = observationJsonSchema.$defs;
    expect(rejects(defs.lifecycle, {})).toBe(true); expect(rejects(defs.session, {})).toBe(true); expect(rejects(defs.session, { kind: "pi-jsonl-path", locator: "relative.jsonl" })).toBe(true); expect(rejects(defs.processBinding, {})).toBe(true);
    expect(rejects(defs.issue, { code: "unknown", scope: "snapshot" })).toBe(true);
    expect(rejects(defs.issue, { code: "runtime_missing", scope: "membership" })).toBe(true);
    expect(rejects(defs.issue, { code: "runtime_missing", scope: "membership", teamName: "alpha", memberName: "worker", membershipId: "worker-1", extra: true })).toBe(true);
  });

  it("orders Teams and Membership records deterministically without expanding the public JSON", async () => {
    const teamsRoot = root();
    const ended = { ...teammate, membershipId: "worker-old", isActive: false, deactivatedAt: "2024-01-01T00:00:03.000Z", deactivationReason: "replaced" as const };
    write(teamsRoot, "zeta", "config.json", { ...config([teammate, ended]), name: "zeta" });
    write(teamsRoot, "alpha", "config.json", { ...config([lead]), name: "alpha" });
    const first = await readObservationSnapshot({ teamsRoot, producerVersion: "consumer-probe" });
    const second = await readObservationSnapshot({ teamsRoot, producerVersion: "consumer-probe" });
    const stable = (snapshot: typeof first) => ({ ...snapshot, generatedAt: "generated-at-is-a-freshness-coordinate" });
    expect(stable(first)).toEqual(stable(second));
    expect(first).toMatchObject({ schema: OBSERVATION_SCHEMA, generatedAt: expect.any(String), producerVersion: "consumer-probe", availability: "partial" });
    expect(first.teams.map(team => [team.teamName, team.memberships.map(member => member.membershipId)])).toEqual([["alpha", ["lead-1"]], ["zeta", ["worker-1", "worker-old"]]]);
    expect(first.teams[1].memberships[1]).toMatchObject({ lifecycle: { state: "ended", reason: "replaced" }, issues: [expect.objectContaining({ code: "runtime_missing", scope: "membership" })] });
    expect(JSON.stringify(first)).not.toMatch(/"(?:message|agentId|cwd|pendingLaunchId|launchConsumedAt|deactivatedAt)"/);
  });

  it("reports missing, malformed, and legacy runtime records while retaining other Membership evidence", async () => {
    const teamsRoot = root();
    const malformed = { ...teammate, membershipId: "worker-malformed", name: "malformed" };
    const legacy = { ...teammate, membershipId: "worker-legacy", name: "legacy" };
    const current = { ...teammate, membershipId: "worker-current", name: "current" };
    write(teamsRoot, "alpha", "config.json", config([teammate, malformed, legacy, current, { name: "old-record" }]));
    write(teamsRoot, "alpha", "runtime/malformed.json", "not json");
    write(teamsRoot, "alpha", "runtime/legacy.json", { teamName: "alpha", agentName: "legacy", pid: 99, startedAt: 1_700_000_000_002, ready: true });
    write(teamsRoot, "alpha", "runtime/current.json", { membershipId: "worker-current", pid: 102, startedAt: 1_700_000_000_003, ready: true });
    const snapshot = await readObservationSnapshot({ teamsRoot }); const members = snapshot.teams[0].memberships;
    expect(snapshot.availability).toBe("partial");
    expect(snapshot.teams[0].issues).toEqual([{ code: "membership_malformed", scope: "team", teamName: "alpha" }]);
    expect(members.map(member => [member.memberName, member.issues.map(issue => issue.code)])).toEqual([["worker", ["runtime_missing"]], ["malformed", ["runtime_malformed"]], ["legacy", ["runtime_legacy"]], ["current", []]]);
    expect(members.slice(0, 3).every(member => member.processBinding === undefined && member.readiness === undefined)).toBe(true);
    expect(members[3]).toMatchObject({ processBinding: { membershipId: "worker-current", pid: 102 }, readiness: true });
  });

  it("fails closed on duplicate Membership IDs and ambiguous current process bindings", async () => {
    const teamsRoot = root(); const second = { ...teammate, name: "worker-two" };
    write(teamsRoot, "alpha", "config.json", config([teammate, second]));
    write(teamsRoot, "alpha", "runtime/worker.json", { membershipId: "worker-1", pid: 101, startedAt: 1_700_000_000_002, ready: true }); write(teamsRoot, "alpha", "runtime/worker-two.json", { membershipId: "worker-1", pid: 101, startedAt: 1_700_000_000_002, ready: true });
    const snapshot = await readObservationSnapshot({ teamsRoot });
    for (const member of snapshot.teams[0].memberships) { expect(member.processBinding).toBeUndefined(); expect(member.readiness).toBeUndefined(); expect(member.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "membership_duplicate", teamName: "alpha", memberName: member.memberName, membershipId: "worker-1" })])); }
  });

  it("omits ambiguous current process bindings rather than choosing a member by order", async () => {
    const teamsRoot = root(); const second = { ...teammate, membershipId: "worker-2", name: "worker-two" };
    write(teamsRoot, "alpha", "config.json", config([teammate, second]));
    write(teamsRoot, "alpha", "runtime/worker.json", { membershipId: "worker-1", pid: 101, startedAt: 1_700_000_000_002, ready: true }); write(teamsRoot, "alpha", "runtime/worker-two.json", { membershipId: "worker-2", pid: 101, startedAt: 1_700_000_000_002, ready: true });
    const members = (await readObservationSnapshot({ teamsRoot })).teams[0].memberships;
    for (const member of members) { expect(member.processBinding).toBeUndefined(); expect(member.readiness).toBeUndefined(); expect(member.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "process_binding_ambiguous", membershipId: member.membershipId })])); }
  });

  it("omits non-absolute Session locators and readiness from mismatched or invalid runtime evidence", async () => {
    const teamsRoot = root(); write(teamsRoot, "alpha", "config.json", config([{ ...teammate, sessionFile: "relative.jsonl" }])); write(teamsRoot, "alpha", "runtime/worker.json", { membershipId: "other", pid: 101, startedAt: 1_700_000_000_002, ready: true });
    const member = (await readObservationSnapshot({ teamsRoot })).teams[0].memberships[0];
    expect(member.session).toBeUndefined(); expect(member.processBinding).toBeUndefined(); expect(member.readiness).toBeUndefined(); expect(member.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "session_locator_invalid", teamName: "alpha" }), expect.objectContaining({ code: "runtime_generation_mismatch", teamName: "alpha" })]));
  });

  it("keeps ended history and isolates corrupt Teams without source-path leakage", async () => {
    const teamsRoot = root(); const ended = { ...teammate, membershipId: "worker-old", isActive: false, deactivatedAt: "2024-01-01T00:00:00.000Z", deactivationReason: "replaced" };
    write(teamsRoot, "alpha", "config.json", config([ended])); write(teamsRoot, "broken", "config.json", "not json");
    const snapshot = await readObservationSnapshot({ teamsRoot });
    expect(snapshot.teams[0].memberships[0].lifecycle).toMatchObject({ state: "ended", reason: "replaced" }); expect(snapshot.issues).toContainEqual({ code: "team_config_malformed", scope: "team", teamName: "broken" }); expect(JSON.stringify(snapshot)).not.toContain("config.json");
  });

  it("excludes Task, profile, model, terminal-content, argv, environment, usage, and Rarebit data", async () => {
    const teamsRoot = root(); write(teamsRoot, "alpha", "config.json", config([{ ...teammate, prompt: "secret", model: "secret-model", subscriptions: [{ task: "secret" }], argv: ["secret"], env: { TOKEN: "secret" }, usage: 1, rarebit: "secret" }]));
    const text = JSON.stringify(await readObservationSnapshot({ teamsRoot })); for (const forbidden of ["prompt", "model", "subscriptions", "argv", "env", "usage", "rarebit", "secret-model"]) expect(text).not.toContain(forbidden);
  });

  it("retries one config generation change then reports changed-during-read", async () => {
    const teamsRoot = root(); const configFile = path.join(teamsRoot, "alpha", "config.json"); write(teamsRoot, "alpha", "config.json", config([teammate]));
    const original = fs.readFileSync; let configReads = 0; const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => { if (file === configFile) return Buffer.from(`${original(file, ...args as [])}${" ".repeat(++configReads)}`); return original(file, ...args as []); }) as any);
    const snapshot = await readObservationSnapshot({ teamsRoot }); spy.mockRestore(); expect(snapshot.issues).toContainEqual({ code: "team_changed_during_read", scope: "team", teamName: "alpha" });
  });

  it("is operationally read-only and ignores existing producer lock files", async () => {
    const teamsRoot = root(); write(teamsRoot, "alpha", "config.json", config([teammate])); write(teamsRoot, "alpha", "config.json.lock", "young lock"); write(teamsRoot, "alpha", "runtime/worker.json.lock", "young lock");
    const manifest = () => { const files: string[] = []; const visit = (dir: string) => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); fs.statSync(file).isDirectory() ? visit(file) : files.push(`${path.relative(teamsRoot, file)}:${fs.readFileSync(file, "utf8")}`); } }; visit(teamsRoot); return files.sort(); };
    const before = manifest(); const started = Date.now(); await readObservationSnapshot({ teamsRoot }); expect(Date.now() - started).toBeLessThan(100); expect(manifest()).toEqual(before);
  });

  it("honors deadline expiry before Team reads", async () => {
    const teamsRoot = root(); write(teamsRoot, "alpha", "config.json", config([teammate])); const snapshot = await readObservationSnapshot({ teamsRoot, deadlineMs: 0 });
    expect(snapshot).toMatchObject({ availability: "unavailable", issues: [{ code: "projection_deadline_exceeded", scope: "snapshot" }] }); expect(snapshot.teams).toEqual([]);
  });

  it("honors a live abort at the Team yield before further reads", async () => {
    const teamsRoot = root(); write(teamsRoot, "alpha", "config.json", config([teammate])); const controller = new AbortController(); const pending = readObservationSnapshot({ teamsRoot, signal: controller.signal }); controller.abort();
    const snapshot = await pending; expect(snapshot).toMatchObject({ availability: "unavailable", issues: [{ code: "projection_aborted", scope: "snapshot" }] }); expect(snapshot.teams).toEqual([]);
  });

  it("consumes a chmod read-only tree without creating producer artifacts", async () => {
    const teamsRoot = root(); write(teamsRoot, "alpha", "config.json", config([teammate])); fs.chmodSync(path.join(teamsRoot, "alpha"), 0o555); fs.chmodSync(teamsRoot, 0o555);
    await expect(readObservationSnapshot({ teamsRoot })).resolves.toMatchObject({ teams: [{ teamName: "alpha" }] }); fs.chmodSync(teamsRoot, 0o755); fs.chmodSync(path.join(teamsRoot, "alpha"), 0o755);
  });

  it("honors an already-aborted signal without reading the Team tree", async () => {
    const teamsRoot = root(); write(teamsRoot, "alpha", "config.json", config([teammate])); const controller = new AbortController(); controller.abort();
    const snapshot = await readObservationSnapshot({ teamsRoot, signal: controller.signal }); expect(snapshot).toMatchObject({ availability: "unavailable", issues: [{ code: "projection_aborted", scope: "snapshot" }] }); expect(snapshot.teams).toEqual([]);
  });

  it("returns typed unavailable root", async () => { const snapshot = await readObservationSnapshot({ teamsRoot: path.join(root(), "missing") }); expect(snapshot).toMatchObject({ schema: OBSERVATION_SCHEMA, availability: "unavailable", issues: [{ code: "teams_root_unavailable", scope: "snapshot" }] }); });
});
