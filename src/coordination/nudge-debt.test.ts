import { describe, expect, it, vi } from "vitest";
import { CoordinationNudgeDebtService } from "./nudge-debt";

const lead = { name: "team-lead", agentType: "lead", membershipId: "lead-1", sessionFile: "/sessions/lead", isActive: true };
const bound = (members: unknown[] = [lead], syncLiveness: Record<string, unknown> = { autoSyncEnabled: true, policyVersion: "2" }) => ({
  teamName: "debt-test", sessionFile: "/sessions/lead",
  config: { epochId: "epoch-1", members, syncLiveness },
});
const found = { kind: "found", projection: { teamEventCursor: "2", authorityRevisions: {} } };
const prepared = (view: "snapshot" | "updates", updateCount: number, scopeKey = "scope-1", marker = "one") => ({
  kind: "prepared", updateCount, scopeKey,
  result: view === "snapshot"
    ? { kind: "snapshot", epochId: "epoch-1", head: 3, team: { name: "debt-test", purpose: marker, lifecycle: "active" }, workers: [], tasks: [] }
    : { kind: "updates", epochId: "epoch-1", head: 3, teamChanges: [], workerChanges: [{ worker: "worker", scope: marker, kind: "created", text: marker }], taskChanges: [], alerts: [] },
});
function service(hidden: unknown = { kind: "missing" }, projection: unknown = prepared("snapshot", 1)) {
  const readHidden = vi.fn().mockResolvedValue(hidden);
  const peekTeamSync = vi.fn().mockResolvedValue(projection);
  return { debt: new CoordinationNudgeDebtService({ peekTeamSync } as any, { readHidden } as any), readHidden, peekTeamSync };
}

describe("Coordination nudge debt from canonical observation", () => {
  it("selects snapshot or updates from the exact hidden baseline and forwards full lineage", async () => {
    const initial = service();
    await expect(initial.debt.read(bound() as any, ["root", "branch"])).resolves.toMatchObject({
      kind: "eligible", requestedView: "snapshot", scopeKey: "scope-1", updateCount: 1,
      leaderMembershipId: "lead-1", branchLineage: ["root", "branch"], branchId: "branch",
    });
    expect(initial.readHidden).toHaveBeenCalledWith("debt-test", {
      teamEpochId: "epoch-1", exactSessionId: "/sessions/lead", branchLineage: ["root", "branch"],
    });
    expect(initial.peekTeamSync).toHaveBeenCalledWith("/sessions/lead", "snapshot", ["root", "branch"]);
    const updates = service(found, prepared("updates", 2));
    await expect(updates.debt.read(bound() as any, ["root"])).resolves.toMatchObject({ kind: "eligible", requestedView: "updates", updateCount: 2 });
    expect(updates.peekTeamSync).toHaveBeenCalledWith("/sessions/lead", "updates", ["root"]);
  });

  it("does not probe when exact identity, lineage, or policy is invalid", async () => {
    const cases = [
      [bound([{ ...lead, agentType: "teammate" }]), ["root"]],
      [bound([{ ...lead, sessionFile: "/sessions/old" }]), ["root"]],
      [bound(), ["root", "root"]],
      [bound(), []],
      [bound([lead], { autoSyncEnabled: false, policyVersion: "2" }), ["root"]],
      [bound([lead], { nudgeEnabled: false, policyVersion: "1" }), ["root"]],
    ] as const;
    for (const [team, lineage] of cases) {
      const candidate = service();
      await expect(candidate.debt.read(team as any, [...lineage])).resolves.toEqual({ kind: "none" });
      expect(candidate.peekTeamSync).not.toHaveBeenCalled();
    }
  });

  it("uses the canonical projected eligible count and does not fabricate debt from other changes", async () => {
    const zero = service(found, prepared("updates", 0));
    await expect(zero.debt.read(bound() as any, ["root"])).resolves.toEqual({ kind: "none" });
    const continuation = service(found, { ...prepared("updates", 0), continuationEligible: true });
    await expect(continuation.debt.read(bound() as any, ["root"])).resolves.toMatchObject({
      kind: "eligible", requestedView: "updates", updateCount: 0, scopeKey: "scope-1",
    });
    const quiet = service(found, { kind: "quiet", updateCount: 0, scopeKey: "scope-1" });
    await expect(quiet.debt.read(bound() as any, ["root"])).resolves.toEqual({ kind: "none" });
    const unknown = service(found, { ...prepared("updates", 1), updateCount: Number.NaN });
    await expect(unknown.debt.read(bound() as any, ["root"])).resolves.toMatchObject({ kind: "indeterminate" });
  });

  it("keeps the scheduling scope stable while its content coordinate changes", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(prepared("updates", 1, "scope-1", "one"))
      .mockResolvedValueOnce(prepared("updates", 2, "scope-1", "two"));
    const debt = new CoordinationNudgeDebtService({ peekTeamSync: probe } as any, { readHidden: async () => found } as any);
    const first = await debt.read(bound() as any, ["root"]);
    const second = await debt.read(bound() as any, ["root"]);
    expect(first.kind).toBe("eligible"); expect(second.kind).toBe("eligible");
    if (first.kind !== "eligible" || second.kind !== "eligible") return;
    expect(second.scopeKey).toBe(first.scopeKey);
    expect(second.debtKey).not.toBe(first.debtKey);
    expect(second.updateCount).toBe(2);
  });

  it("suppresses mismatched views and unavailable observations", async () => {
    const mismatch = service(found, prepared("snapshot", 1));
    await expect(mismatch.debt.read(bound() as any, ["root"])).resolves.toMatchObject({ kind: "indeterminate" });
    const unavailable = service(found, { kind: "unavailable", message: "Task store offline" });
    await expect(unavailable.debt.read(bound() as any, ["root"])).resolves.toEqual({ kind: "unavailable", message: "Task store offline" });
    const rejected = service(found);
    rejected.peekTeamSync.mockRejectedValueOnce(new Error("probe offline"));
    await expect(rejected.debt.read(bound() as any, ["root"])).resolves.toMatchObject({ kind: "indeterminate" });
  });
});
