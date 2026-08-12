import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitRuntimeStartup, preflightRuntimeRecovery, readRuntimeStatus, type AgentRuntimeStatus, writeRuntimeStatus } from "./runtime";
import * as paths from "./paths";
import * as teams from "./teams";

const bound = { name: "worker", membershipId: "member-1", sessionFile: "/tmp/worker.jsonl" };
const generation: AgentRuntimeStatus = {
  teamName: "team", agentName: "worker", membershipId: "member-1", pid: 4242, startedAt: 10,
};

const testTeams: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of testTeams.splice(0)) fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
});

describe("runtime startup admission", () => {
  it("admits a prepared first binding and same-process re-entry", () => {
    expect(admitRuntimeStartup({ name: "worker", membershipId: "member-1", pendingLaunchId: "launch-1" }, "/tmp/worker.jsonl", null, process.pid, undefined, "launch-1"))
      .toMatchObject({ kind: "admitted", action: "claim" });
    expect(admitRuntimeStartup(bound, "/tmp/worker.jsonl", { ...generation, pid: process.pid }))
      .toMatchObject({ kind: "admitted", action: "already_current" });
  });

  it("fences a prepared retry after a post-claim bind failure", () => {
    const prepared = { name: "worker", membershipId: "member-1", pendingLaunchId: "launch-1" };
    const claimed = { ...generation, pid: 4242 };
    expect(admitRuntimeStartup(prepared, "/tmp/worker.jsonl", claimed, 4242, () => "occupied", "launch-1"))
      .toMatchObject({ kind: "refused", reason: expect.stringMatching(/live or unverified/i) });
    expect(admitRuntimeStartup(prepared, "/tmp/worker.jsonl", claimed, 9999, () => "absent", "launch-1"))
      .toMatchObject({ kind: "admitted", action: "claim", replaces: { pid: 4242, membershipId: "member-1" } });
  });

  it("serializes distinct candidate PIDs so only one claims and binds", async () => {
    const teamName = `runtime-admission-barrier-${process.pid}-${Date.now()}`;
    testTeams.push(teamName);
    await teams.createTeam(teamName, "lead-session", "lead");
    const launchId = teams.newLaunchId();
    const worker = {
      membershipId: teams.newMembershipId(), pendingLaunchId: launchId, agentId: `worker@${teamName}`,
      name: "worker", agentType: "teammate" as const, joinedAt: Date.now(), tmuxPaneId: "",
      cwd: process.cwd(), subscriptions: [],
    };
    await teams.addMember(teamName, worker);
    const bind = vi.spyOn(teams, "bindMemberSession");
    const claims: number[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstClaimed!: () => void;
    const firstClaimedBarrier = new Promise<void>((resolve) => { firstClaimed = resolve; });
    const start = (pid: number, hold = false) => teams.withCurrentMembershipLease(teamName, worker.membershipId, async (current) => {
      const admission = admitRuntimeStartup(
        current, "/tmp/runtime-admission-barrier.jsonl", await readRuntimeStatus(teamName, "worker"), pid,
        () => "occupied", launchId,
      );
      if (admission.kind === "refused") return admission;
      claims.push(pid);
      await writeRuntimeStatus(teamName, "worker", { pid, startedAt: pid }, current.membershipId);
      await teams.bindMemberSession(teamName, "worker", "/tmp/runtime-admission-barrier.jsonl", launchId, {}, current.membershipId);
      if (hold) {
        firstClaimed();
        await firstHeld;
      }
      return admission;
    });
    const first = start(101, true);
    await firstClaimedBarrier;
    const second = start(202);
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toMatchObject({ kind: "admitted", action: "claim" });
    expect(secondResult).toMatchObject({ kind: "refused" });
    expect(claims).toEqual([101]);
    expect(bind).toHaveBeenCalledOnce();
    expect(await readRuntimeStatus(teamName, "worker")).toMatchObject({ pid: 101, membershipId: worker.membershipId });
  });

  it("keeps recovery preflight pure while rejecting a live prepared or bound generation", () => {
    const prepared = { name: "worker", membershipId: "member-1", pendingLaunchId: "launch-1" };
    expect(preflightRuntimeRecovery(prepared, null, () => "occupied", "launch-1")).toEqual({ kind: "ready" });
    expect(preflightRuntimeRecovery(prepared, generation, () => "occupied", "launch-1"))
      .toMatchObject({ kind: "refused", reason: expect.stringMatching(/live or unverified/i) });
    expect(preflightRuntimeRecovery(bound, generation, () => "absent"))
      .toEqual({ kind: "ready", replaces: { membershipId: "member-1", pid: 4242, startedAt: 10 } });
    expect(preflightRuntimeRecovery(bound, null, () => "absent"))
      .toMatchObject({ kind: "refused", reason: expect.stringMatching(/missing/i) });
    expect(preflightRuntimeRecovery(bound, { ...generation, pid: 0 }, () => "absent"))
      .toMatchObject({ kind: "refused", reason: expect.stringMatching(/malformed/i) });
    expect(preflightRuntimeRecovery(bound, { ...generation, membershipId: "old-member" }, () => "absent"))
      .toMatchObject({ kind: "refused", reason: expect.stringMatching(/another Membership/i) });
  });

  it("refuses a live exact-Session incumbent before replacement", () => {
    const probe = vi.fn(() => "occupied" as const);
    expect(admitRuntimeStartup(bound, "/tmp/worker.jsonl", generation, 9999, probe))
      .toMatchObject({ kind: "refused", reason: expect.stringMatching(/live or unverified/i) });
    expect(probe).toHaveBeenCalledWith(4242);
  });

  it("permits sequential exact-Session resume only after ESRCH-equivalent absence", () => {
    expect(admitRuntimeStartup(bound, "/tmp/worker.jsonl", generation, 9999, () => "absent"))
      .toMatchObject({ kind: "admitted", replaces: { pid: 4242, membershipId: "member-1" } });
  });

  it.each([
    [null],
    [{ ...generation, membershipId: "old-member" }],
    [{ ...generation, pid: 0 }],
  ])("fails closed for ambiguous bound runtime evidence: %o", (status) => {
    expect(admitRuntimeStartup(bound, "/tmp/worker.jsonl", status as AgentRuntimeStatus | null, 9999))
      .toMatchObject({ kind: "refused", reason: expect.stringMatching(/missing, malformed, or belongs/i) });
  });

  it("treats EPERM and unknown probe errors as occupied", () => {
    const eperm = new Error("denied") as NodeJS.ErrnoException;
    eperm.code = "EPERM";
    const unknown = new Error("unknown") as NodeJS.ErrnoException;
    for (const error of [eperm, unknown]) {
      vi.spyOn(process, "kill").mockImplementationOnce(() => { throw error; });
      expect(admitRuntimeStartup(bound, "/tmp/worker.jsonl", generation, 9999))
        .toMatchObject({ kind: "refused" });
    }
  });
});
