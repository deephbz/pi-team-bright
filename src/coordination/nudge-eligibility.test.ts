import { describe, expect, it } from "vitest";
import { CoordinationObservationService } from "./observation-service";

function serviceWithInjectedDerivedStore(config: any, calls: string[]) {
  return new CoordinationObservationService({
    teamRuntime: {
      readLeaderBinding: async (sessionFile) => { calls.push(`binding:${sessionFile}`); return config; },
      readRuntime: async () => null,
    },
    taskStateDelivery: {
      listTaskIds: async () => { calls.push("list"); return []; },
      readTasks: async () => { calls.push("read"); return []; },
      readDeliveryEvidence: async () => ({ known: true, pending: false }),
    },
    alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
  }, {
    projectNonterminalTaskIds: () => [],
    projectTaskChanges: () => ({ kind: "projected", changes: [] }),
  }, undefined, undefined, {
    readHidden: async () => { calls.push("hidden"); return { kind: "missing" }; },
    readEvents: () => { calls.push("events"); return { events: [], headCursor: "0", cursor: "0", truncated: false }; },
    readFailureHints: () => ({ headCursor: "0", hints: [] }),
  });
}

const exactLead = {
  teamName: "nudge-eligibility",
  epochId: "epoch-1",
  sessionFile: "/sessions/lead",
  syncLiveness: { waitSeconds: 120, nudgeEnabled: true, nudgeDelaySeconds: 5 },
  members: [{ name: "team-lead", agentType: "lead", membershipId: "lead-1", sessionFile: "/sessions/lead", isActive: true }],
};

describe("Coordination nudge eligibility compatibility", () => {
  it("passes an exact lead without logicalWorkers to its injected derived-store boundary", async () => {
    const calls: string[] = [];
    // This is a Coordination seam test. The durable port owns the strict
    // logical_workers_missing oracle in durable-model-tool-port.test.ts.
    const result = await serviceWithInjectedDerivedStore(exactLead, calls).readSyncNudgeDebt("/sessions/lead", ["root"]);

    expect(exactLead).not.toHaveProperty("logicalWorkers");
    expect(result).toMatchObject({ kind: "eligible", requestedView: "snapshot", debtKey: expect.stringContaining("|undefined") });
    expect((result as any).policyVersion).toBeUndefined();
    expect(calls).toEqual(["binding:/sessions/lead", "hidden", "list", "read", "events"]);
  });

  it("requires the current exact lead Membership before any nudge-derived read", async () => {
    const calls: string[] = [];
    const config = { ...exactLead, members: [{ ...exactLead.members[0], sessionFile: "/sessions/other" }] };
    await expect(serviceWithInjectedDerivedStore(config, calls).readSyncNudgeDebt("/sessions/lead", ["root"])).resolves.toEqual({ kind: "none" });
    expect(calls).toEqual(["binding:/sessions/lead"]);
  });
});
