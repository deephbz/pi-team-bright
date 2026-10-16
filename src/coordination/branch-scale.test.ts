import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { snapshotEntry } from "../../test/support/branch-observation";
import type { BranchEntry } from "./branch-observation";
import { CoordinationObservationService } from "./observation-service";

// A long-lived lead Session: tens of thousands of native entries, with Team updates spread through them.
const ENTRIES = 30_000;
const UPDATES = 1_500;
const FILE = "/tmp/lead.jsonl";

function longBranch(): BranchEntry[] {
  const every = Math.floor(ENTRIES / UPDATES);
  return Array.from({ length: ENTRIES }, (_, index) => index % every === 0
    ? snapshotEntry(`update-${index}`, "scale-team", "epoch", "lead", [], 1)
    : { id: `entry-${index}`, type: "message", message: { role: "user" } } as BranchEntry);
}

function service(): CoordinationObservationService {
  return new CoordinationObservationService({
    teamRuntime: {
      readRuntime: vi.fn(),
      readLeaderBinding: vi.fn(async () => ({
        teamName: "scale-team", epochId: "epoch", sessionFile: FILE, purpose: "fixture",
        members: [{ name: "team-lead", agentType: "lead", membershipId: "lead", sessionFile: FILE, isActive: true }],
        logicalWorkers: [],
      })),
    },
    taskStateDelivery: {
      completeTaskSet: () => true,
      listTaskIds: vi.fn(async () => []),
      readTasks: vi.fn(async () => []),
      readDeliveryEvidence: vi.fn(async () => ({ known: true, pending: false })),
    },
    alertActuation: { readInboxEvidence: vi.fn(async () => ({ known: true, pending: false })) },
    receivedAlerts: { readRecentReceivedAlerts: async () => ({ alerts: [], omitted: 0 }) },
  } as never, { projectNonterminalTaskIds: () => [], projectTaskChanges: () => ({ kind: "projected", changes: [] }) } as never, {
    readEvents: vi.fn(() => ({ events: [], cursor: "1", headCursor: "1", truncated: false, remaining: 0 })),
    readEventCursor: vi.fn(() => "1"),
  } as never);
}

describe("lead branch observation scale", () => {
  // Pi runs these calls on the lead's main thread at every team_sync and sync-liveness probe.
  it("keeps every branch operation linear in the lead's Session length", async () => {
    const branch = longBranch();
    const ids = branch.map(entry => entry.id);
    const instance = service();
    const timings: Record<string, number> = {};
    const time = async (label: string, action: () => unknown) => {
      const start = performance.now();
      await action();
      timings[label] = Math.round(performance.now() - start);
    };

    await time("setBranchEntries", () => instance.setBranchEntries(FILE, branch));
    await time("setBranchContext", () => instance.setBranchContext(FILE, ids));
    await time("selectTeamSyncView", async () => expect(await instance.selectTeamSyncView(FILE, ids)).toBe("updates"));
    await time("peekTeamSync", () => instance.peekTeamSync(FILE, "updates", ids));
    await time("readTeamSync", async () => expect(await instance.readTeamSync(FILE, "updates", new AbortController().signal, "sync")).toMatchObject({ kind: "caught_up" }));
    await time("setBranchEntries with a held observation", () => instance.setBranchEntries(FILE, branch));

    // Linear work takes tens of milliseconds here; the quadratic loops took seconds.
    const total = Object.values(timings).reduce((sum, value) => sum + value, 0);
    expect(total, JSON.stringify(timings)).toBeLessThan(1_500);
  }, 120_000);
});
