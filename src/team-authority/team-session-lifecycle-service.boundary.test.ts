import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  config: { name: "team", members: [] as any[] },
  current: null as any,
  lookup: vi.fn(async () => fixture.current),
  admission: { kind: "admitted" } as any,
  runtimeStatus: null as any,
  runtimeAdmission: { kind: "admitted", action: "claim" } as any,
  events: [] as string[],
  writeRuntime: vi.fn(async () => ({})),
  bind: vi.fn(async () => fixture.current),
  publish: vi.fn(async () => ({ cursor: "1" })),
  failed: vi.fn(async () => ({ cursor: "1" })),
  update: vi.fn(async () => undefined),
  runtimePath: "/tmp/pi-team-session-boundary.json",
}));

vi.mock("../utils/paths", () => ({ leadSessionPath: () => fixture.runtimePath }));
vi.mock("../utils/session-terminal", () => ({ admitTeamSession: () => fixture.admission }));
vi.mock("../utils/runtime", () => ({
  readRuntimeStatus: async () => fixture.runtimeStatus,
  admitRuntimeStartup: (...args: unknown[]) => { fixture.events.push("runtime-claim"); return fixture.runtimeAdmission; },
  probePidPresence: () => "occupied",
  writeRuntimeStatus: () => { fixture.events.push("runtime-write"); return fixture.writeRuntime(); },
}));
vi.mock("../utils/teams", () => ({
  readConfig: async () => fixture.config,
  currentMembership: () => { fixture.events.push("current-lookup"); return fixture.lookup(); },
  withCurrentMembershipLease: async (_team: string, membershipId: string, action: (member: any) => Promise<unknown>) => {
    fixture.events.push(`lease:${membershipId}`);
    return action(fixture.current);
  },
  bindMemberSession: () => { fixture.events.push("bind"); return fixture.bind(); },
  updateMembership: () => { fixture.events.push("membership-update"); return fixture.update(); },
  assertCurrentSessionBinding: () => { fixture.events.push("exact-binding"); return fixture.current; },
}));

import { TeamSessionLifecycleService } from "./team-session-lifecycle-service";
import type { TeamLifecyclePublication } from "./team-lifecycle-publication";

function member(name: string, sessionFile?: string) {
  return { name, membershipId: `${name}-membership`, agentType: name === "team-lead" ? "lead" : "teammate", isActive: true, pendingLaunchId: "launch", ...(sessionFile ? { sessionFile } : {}) };
}

function publication(): TeamLifecyclePublication {
  return {
    readEventCursor: () => "0",
    recordWorkerPrepared: async () => ({ cursor: "0" }),
    recordWorkerStopped: async () => ({ cursor: "0" }),
    recordWorkerSessionBound: () => { fixture.events.push("session-bound"); return fixture.publish(); },
    recordWorkerFailed: () => { fixture.events.push("failed-event"); return fixture.failed(); },
    observeWorkerStartup: async () => ({ observed: false, carrier: "prepared", runtime: "not_observed", cursor: "0", reason: "timeout" }),
  };
}

function reset() {
  fixture.config = { name: "team", members: [] };
  fixture.current = null;
  fixture.lookup.mockReset().mockImplementation(async () => fixture.current);
  fixture.admission = { kind: "admitted" };
  fixture.runtimeStatus = null;
  fixture.runtimeAdmission = { kind: "admitted", action: "claim" };
  fixture.events = [];
  fixture.writeRuntime.mockReset().mockResolvedValue({});
  fixture.bind.mockReset().mockImplementation(async () => fixture.current);
  fixture.publish.mockReset().mockResolvedValue({ cursor: "1" });
  fixture.failed.mockReset().mockResolvedValue({ cursor: "1" });
  fixture.update.mockReset().mockResolvedValue(undefined);
  try { fs.unlinkSync(fixture.runtimePath); } catch {}
}
afterEach(reset);

const workerInput = { teamName: "team", workerName: "worker", sessionFile: "/tmp/worker.jsonl", placement: { kind: "unlocated" } as const, identitySource: "launch_env" as const, launchId: "launch" };

describe("Team Session lifecycle boundary", () => {
  it("refuses lead placement before any current-binding lookup", async () => {
    reset();
    fixture.admission = { kind: "refused", reason: "foreign terminal", exitProcess: false };
    const service = new TeamSessionLifecycleService(publication());
    await expect(service.admitLead({ teamName: "team", sessionFile: "/tmp/lead.jsonl", placement: { kind: "foreign", expected: "tmux", actual: "herdr" }, identitySource: "resumed_session" })).resolves.toEqual(fixture.admission);
    expect(fixture.events).toEqual([]);
    expect(fixture.lookup).not.toHaveBeenCalled();
  });

  it.each(["claim", "already_current"] as const)("returns the exact lead Membership after a stale pre-service config snapshot on %s", async (action) => {
    reset();
    const stale = member("team-lead", "/tmp/old-lead.jsonl");
    const exact = { ...member("team-lead", "/tmp/lead.jsonl"), membershipId: "exact-lead-membership" };
    fixture.config.members = [stale];
    fixture.current = exact;
    fixture.runtimeStatus = action === "claim" ? null : { membershipId: exact.membershipId, pid: process.pid, startedAt: 1 };
    fixture.runtimeAdmission = { kind: "admitted", action };
    const service = new TeamSessionLifecycleService(publication());
    const result = await service.admitLead({ teamName: "team", sessionFile: "/tmp/lead.jsonl", placement: { kind: "unlocated" }, identitySource: "resumed_session", allowFirstRuntimeGeneration: action === "claim" });
    expect(result).toMatchObject({ kind: "admitted", action, member: { membershipId: "exact-lead-membership", sessionFile: "/tmp/lead.jsonl" } });
    expect(fixture.events.slice(0, 2)).toEqual(["exact-binding", "lease:exact-lead-membership"]);
  });

  it("claims a first lead generation, then preserves an already-current generation without rewrite", async () => {
    reset();
    fixture.current = member("team-lead", "/tmp/lead.jsonl");
    fixture.config.members = [fixture.current];
    const service = new TeamSessionLifecycleService(publication());

    await expect(service.admitLead({ teamName: "team", sessionFile: "/tmp/lead.jsonl", placement: { kind: "unlocated" }, identitySource: "resumed_session", allowFirstRuntimeGeneration: true })).resolves.toMatchObject({ kind: "admitted", action: "claim" });
    expect(fixture.events).toEqual(["exact-binding", "lease:team-lead-membership", "runtime-write"]);
    fixture.runtimeStatus = { membershipId: "team-lead-membership", pid: process.pid, startedAt: 1 };
    fixture.runtimeAdmission = { kind: "admitted", action: "already_current" };
    fixture.events = [];
    await expect(service.admitLead({ teamName: "team", sessionFile: "/tmp/lead.jsonl", placement: { kind: "unlocated" }, identitySource: "resumed_session" })).resolves.toMatchObject({ kind: "admitted", action: "already_current", member: { membershipId: "team-lead-membership" } });
    expect(fixture.events).toEqual(["exact-binding", "lease:team-lead-membership", "runtime-claim"]);
    expect(fixture.writeRuntime).toHaveBeenCalledTimes(1);
  });

  it("orders Worker runtime claim, fence write, exact bind, then session-bound publication", async () => {
    reset(); fixture.current = member("worker"); fixture.config.members = [fixture.current];
    const service = new TeamSessionLifecycleService(publication());
    await expect(service.admitWorker(workerInput)).resolves.toMatchObject({ kind: "admitted", action: "claim" });
    expect(fixture.events).toEqual(["current-lookup", "lease:worker-membership", "runtime-claim", "runtime-write", "bind", "session-bound"]);
  });

  it("does not rewrite runtime, bind, or publish twice for an already-current Worker PID", async () => {
    reset(); fixture.current = member("worker", "/tmp/worker.jsonl"); fixture.config.members = [fixture.current];
    fixture.runtimeAdmission = { kind: "admitted", action: "already_current" };
    const service = new TeamSessionLifecycleService(publication());
    await expect(service.admitWorker(workerInput)).resolves.toMatchObject({ kind: "admitted", action: "already_current", member: fixture.current });
    expect(fixture.events).toEqual(["current-lookup", "lease:worker-membership", "runtime-claim"]);
    expect(fixture.writeRuntime).not.toHaveBeenCalled(); expect(fixture.bind).not.toHaveBeenCalled(); expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("refuses stale or live Worker admissions before any runtime rewrite", async () => {
    reset(); fixture.current = member("worker"); fixture.config.members = [fixture.current];
    fixture.runtimeAdmission = { kind: "refused", reason: "already live" };
    const service = new TeamSessionLifecycleService(publication());
    await expect(service.admitWorker(workerInput)).resolves.toEqual({ kind: "refused", reason: "already live", exitProcess: true });
    expect(fixture.events).toEqual(["current-lookup", "lease:worker-membership", "runtime-claim"]);
    expect(fixture.writeRuntime).not.toHaveBeenCalled(); expect(fixture.bind).not.toHaveBeenCalled();
  });

  it("retains the claimed runtime fence when exact Session bind fails", async () => {
    reset(); fixture.current = member("worker"); fixture.config.members = [fixture.current]; fixture.bind.mockRejectedValue(new Error("bind failed"));
    const service = new TeamSessionLifecycleService(publication());
    await expect(service.admitWorker(workerInput)).rejects.toThrow("bind failed");
    expect(fixture.events).toEqual(["current-lookup", "lease:worker-membership", "runtime-claim", "runtime-write", "bind"]);
    expect(fixture.writeRuntime).toHaveBeenCalledOnce(); expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("retains the runtime fence and binding when session-bound publication fails", async () => {
    reset(); fixture.current = member("worker"); fixture.config.members = [fixture.current]; fixture.bind.mockImplementation(async () => ({ ...fixture.current, sessionFile: "/tmp/worker.jsonl" })); fixture.publish.mockRejectedValue(new Error("session-bound append failed"));
    const service = new TeamSessionLifecycleService(publication());
    await expect(service.admitWorker(workerInput)).rejects.toThrow("session-bound append failed");
    expect(fixture.events).toEqual(["current-lookup", "lease:worker-membership", "runtime-claim", "runtime-write", "bind", "session-bound"]);
    expect(fixture.writeRuntime).toHaveBeenCalledOnce(); expect(fixture.bind).toHaveBeenCalledOnce();
  });

  it("refuses a stale bound-Session runtime update without writing", async () => {
    reset(); fixture.current = member("worker", "/tmp/worker.jsonl");
    const service = new TeamSessionLifecycleService(publication());
    await expect(service.writeBoundWorkerRuntime({ teamName: "team", workerName: "worker", sessionFile: "/tmp/worker.jsonl", membershipId: "old-membership", updates: { ready: true } })).rejects.toThrow("Runtime update rejected for stale Membership of worker on team team.");
    expect(fixture.writeRuntime).not.toHaveBeenCalled();
  });

  it("records admission failure as best-effort at the registered caller boundary", async () => {
    reset(); fixture.current = member("worker"); fixture.failed.mockRejectedValue(new Error("event unavailable"));
    const service = new TeamSessionLifecycleService(publication());
    await expect(service.recordAdmissionFailure("team", "worker").catch(() => undefined)).resolves.toBeUndefined();
    expect(fixture.events).toEqual(["current-lookup", "failed-event"]);
  });

  it("keeps Team startup realization free of Pi hooks and concrete Coordination", () => {
    const source = fs.readFileSync(path.join(__dirname, "team-session-lifecycle-service.ts"), "utf8");
    const extension = fs.readFileSync(path.join(__dirname, "../../extensions/index.ts"), "utf8");
    expect(source).toContain("class TeamSessionLifecycleService");
    expect(source).toContain("lifecyclePublication: TeamLifecyclePublication");
    expect(source).not.toMatch(/extensions\/|team-events|model-tool-contract/);
    expect(extension).toContain("const teamSessionLifecycleService = new TeamSessionLifecycleService(lifecyclePublication)");
    expect(extension).toContain("await teamSessionLifecycleService.admitLead({");
    expect(extension).not.toContain("registerLeadSession(");
  });
});
