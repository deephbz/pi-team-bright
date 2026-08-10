import { describe, expect, it } from "vitest";
import { taskProjectionRevision } from "./observation-service";
import { CoordinationNudgeDebtService } from "./nudge-debt";

const task = { id: "task-1", version: "v_0123456789abcdef" } as any;
const bound = (members: any[] = [{ name: "team-lead", agentType: "lead", membershipId: "lead-1", sessionFile: "/sessions/lead", isActive: true }]) => ({
  teamName: "nudge-debt-test",
  sessionFile: "/sessions/lead",
  config: { epochId: "epoch-1", members, syncLiveness: { nudgeEnabled: true, nudgeDelaySeconds: 5, policyVersion: "1" } },
});

function service(overrides: Record<string, unknown> = {}) {
  const observation = { readTaskProjection: async () => ({ kind: "tasks", tasks: [task], warnings: [] }) };
  const store = {
    readHidden: () => ({ kind: "missing" }),
    readEvents: () => ({ events: [], headCursor: "0", cursor: "0", truncated: false }),
    readFailureHints: () => ({ cursor: "0", headCursor: "0", hints: [] }),
    ...overrides,
  };
  return new CoordinationNudgeDebtService(observation as any, store as any);
}

const found = (overrides: Record<string, unknown> = {}) => ({
  kind: "found",
  projection: {
    teamEventCursor: "0",
    authorityRevisions: { task_projection: taskProjectionRevision([task]), task_event_failure_hints: "0" },
    ...overrides,
  },
});

describe("Coordination nudge debt equivalence", () => {
  it("derives snapshot debt only for an exact active lead and distinct full lineage", async () => {
    const debt = await service().read(bound() as any, ["root", "branch"]);
    expect(debt).toMatchObject({ kind: "eligible", requestedView: "snapshot", leaderMembershipId: "lead-1", branchLineage: ["root", "branch"] });
    await expect(service().read(bound() as any, ["root", "root"])).resolves.toEqual({ kind: "none" });
    await expect(service().read(bound([{ name: "team-lead", agentType: "teammate", membershipId: "wrong-kind", sessionFile: "/sessions/lead", isActive: true }]) as any, ["root"])).resolves.toEqual({ kind: "none" });
  });

  it("suppresses leader-only changes but arms external events and failure hints", async () => {
    const leaderOnly = service({
      readHidden: () => found(),
      readEvents: () => ({ events: [{ type: "task", actor: "team-lead" }], headCursor: "1", cursor: "1", truncated: false }),
    });
    await expect(leaderOnly.read(bound() as any, ["root"])).resolves.toEqual({ kind: "none" });

    const externalEvent = service({
      readHidden: () => found(),
      readEvents: () => ({ events: [{ type: "task", actor: "worker" }], headCursor: "1", cursor: "1", truncated: false }),
    });
    await expect(externalEvent.read(bound() as any, ["root"])).resolves.toMatchObject({ kind: "eligible", requestedView: "updates" });

    const externalHint = service({
      readHidden: () => found(),
      readFailureHints: () => ({ cursor: "1", headCursor: "1", hints: [{ actorKind: "non-leader/external" }] }),
    });
    await expect(externalHint.read(bound() as any, ["root"])).resolves.toMatchObject({ kind: "eligible", requestedView: "updates" });
  });

  it("returns indeterminate or unavailable without inventing provenance", async () => {
    const unknownActor = service({ readHidden: () => found({ authorityRevisions: { task_projection: "old", task_event_failure_hints: "0" } }) });
    await expect(unknownActor.read(bound() as any, ["root"])).resolves.toMatchObject({ kind: "indeterminate" });

    const brokenHints = service({ readHidden: () => found(), readFailureHints: () => { throw new Error("hint store offline"); } });
    await expect(brokenHints.read(bound() as any, ["root"])).resolves.toMatchObject({ kind: "indeterminate", message: expect.stringContaining("hint store offline") });

    const unavailableTasks = new CoordinationNudgeDebtService(
      { readTaskProjection: async () => ({ kind: "unavailable", message: "Task store offline" }) } as any,
      { readHidden: () => ({ kind: "missing" }), readEvents: () => ({ events: [], headCursor: "0", cursor: "0", truncated: false }), readFailureHints: () => ({ cursor: "0", headCursor: "0", hints: [] }) } as any,
    );
    await expect(unavailableTasks.read(bound() as any, ["root"])).resolves.toEqual({ kind: "unavailable", message: "Task store offline" });
  });

  it("uses later event pages and the replacement lead identity in its update coordinate", async () => {
    let page = 0;
    const paged = service({
      readHidden: () => found(),
      readEvents: () => page++ === 0
        ? { events: [{ type: "task", actor: "team-lead" }], headCursor: "2", cursor: "1", truncated: true }
        : { events: [{ type: "task", actor: "worker" }], headCursor: "2", cursor: "2", truncated: false },
    });
    const members = [
      { name: "team-lead", agentType: "lead", membershipId: "old-lead", sessionFile: "/sessions/lead", isActive: false },
      { name: "team-lead", agentType: "lead", membershipId: "new-lead", sessionFile: "/sessions/lead", isActive: true },
    ];
    await expect(paged.read(bound(members) as any, ["root", "branch"])).resolves.toMatchObject({ kind: "eligible", requestedView: "updates", leaderMembershipId: "new-lead" });
  });
});
