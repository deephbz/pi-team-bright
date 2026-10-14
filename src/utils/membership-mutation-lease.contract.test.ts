import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Member } from "../team-authority/contracts";
import * as paths from "./paths";
import * as teams from "./teams";

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const names: string[] = [];
function member(teamName: string, name: string): Member {
  return { membershipId: teams.newMembershipId(), agentId: `${name}@${teamName}`, name, agentType: name === "team-lead" ? "lead" : "teammate", joinedAt: Date.now(), sessionFile: `/tmp/${teamName}-${name}.jsonl`, cwd: process.cwd(), subscriptions: [], isActive: true };
}
async function fixture() {
  const teamName = `membership-graph-lease-${process.pid}-${Date.now()}-${names.length}`; names.push(teamName);
  const config = await teams.createTeam(teamName, `/tmp/${teamName}-lead.jsonl`, `lead@${teamName}`);
  const alpha = member(teamName, "alpha"); const beta = member(teamName, "beta");
  await teams.addMember(teamName, alpha); await teams.addMember(teamName, beta);
  return { teamName, lead: config.members[0], alpha, beta };
}
afterEach(() => { for (const name of names.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true }); });

describe("Membership-scoped graph mutation lease contract", () => {
  it("serializes one Membership, permits another, and does not hold TeamConfig across a slow graph operation", async () => {
    const f = await fixture(); const alphaGate = deferred(); const alphaSecondGate = deferred(); const betaGate = deferred();
    const entered = new Set<string>(); const active = new Set<string>(); let peak = 0;
    const operation = (member: Member, key: string, gate: Deferred) => teams.withMembershipMutationLease(f.teamName, member.membershipId!, async () => {
      entered.add(key); active.add(key); peak = Math.max(peak, active.size); await gate.promise; active.delete(key);
    });
    const first = operation(f.alpha, "alpha-1", alphaGate);
    const second = operation(f.alpha, "alpha-2", alphaSecondGate);
    const other = operation(f.beta, "beta-1", betaGate);
    while (!entered.has("alpha-1") || !entered.has("beta-1")) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(entered.has("alpha-2")).toBe(false); expect(peak).toBe(2);
    await expect(teams.readConfig(f.teamName)).resolves.toBeDefined();
    alphaGate.resolve(); betaGate.resolve(); await Promise.all([first, other]);
    while (!entered.has("alpha-2")) await new Promise(resolve => setTimeout(resolve, 5));
    alphaSecondGate.resolve(); await second;
  });

  it("makes same-name replacement wait for the old graph mutation and fences the retired Membership", async () => {
    const f = await fixture(); const gate = deferred(); let entered = false;
    const mutation = teams.withMembershipMutationLease(f.teamName, f.alpha.membershipId!, async () => { entered = true; await gate.promise; });
    while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
    let replacementFinished = false;
    const replacement = (async () => {
      await teams.withCurrentMembershipLease(f.teamName, f.alpha.membershipId!, async () => teams.deactivateMembership(f.teamName, f.alpha.membershipId!, "replaced"));
      await teams.addMember(f.teamName, member(f.teamName, "alpha")); replacementFinished = true;
    })();
    await new Promise(resolve => setTimeout(resolve, 30)); expect(replacementFinished).toBe(false);
    gate.resolve(); await mutation; await replacement;
    await expect(teams.withCurrentMembershipLease(f.teamName, f.alpha.membershipId!, async () => undefined)).rejects.toThrow(/no longer current|stale/i);
    const current = (await teams.readConfig(f.teamName)).members.filter(candidate => candidate.name === "alpha" && candidate.isActive !== false);
    expect(current).toHaveLength(1); expect(current[0].membershipId).not.toBe(f.alpha.membershipId);
  });

  it("makes shutdown wait for in-flight Membership mutations before invalidating writers", async () => {
    const f = await fixture(); const gate = deferred(); let entered = false;
    const mutation = teams.withMembershipMutationLease(f.teamName, f.beta.membershipId!, async () => { entered = true; await gate.promise; });
    while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
    let shutdownFinished = false;
    const shutdown = (async () => {
      const current = (await teams.readConfig(f.teamName)).members.filter(candidate => candidate.isActive !== false);
      await Promise.all(current.map(candidate => teams.withCurrentMembershipLease(f.teamName, candidate.membershipId!, async () => teams.deactivateMembership(f.teamName, candidate.membershipId!, "team_shutdown"))));
      shutdownFinished = true;
    })();
    await new Promise(resolve => setTimeout(resolve, 30)); expect(shutdownFinished).toBe(false);
    gate.resolve(); await mutation; await shutdown;
    expect((await teams.readConfig(f.teamName)).members.every(candidate => candidate.isActive === false)).toBe(true);
  });

  it("bounds lease waiting and never runs a timed-out contender", async () => {
    const f = await fixture(); const entered = deferred(); const release = deferred();
    const holder = teams.withMembershipMutationLease(f.teamName, f.alpha.membershipId!, async () => { entered.resolve(); await release.promise; });
    await entered.promise; let called = false;
    await expect(teams.withMembershipMutationLease(f.teamName, f.alpha.membershipId!, async () => { called = true; }, { retries: 2 })).rejects.toThrow(/could not acquire lock/i);
    expect(called).toBe(false); release.resolve(); await holder;
  });
});
