import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CoordinationObservationService } from "./observation-service";
import type { CoordinationQueryBundle } from "./queries";
import { readWorkerRunObservation } from "../utils/sync-liveness";

const teamName = "coordination-hidden-port";
const sessionFile = "/sessions/exact-lead.jsonl";
const task = {
  id: "task-1",
  title: "Canonical Task",
  goal: "Keep the hidden-observation boundary injected.",
  current_context: "Characterization context.",
  status: "open",
  version: "v_0123456789abcdef",
} as any;

function queries(overrides: Partial<CoordinationQueryBundle> = {}): CoordinationQueryBundle {
  return {
    teamRuntime: {
      readLeaderBinding: vi.fn(async () => ({
        teamName,
        epochId: "epoch-1",
        sessionFile,
        purpose: "Characterize the hidden port.",
        syncLiveness: { waitSeconds: 0, nudgeEnabled: true, nudgeDelaySeconds: 0, policyVersion: "test" },
        logicalWorkers: [],
        members: [{ name: "team-lead", agentType: "lead", membershipId: "lead-1", sessionFile, isActive: true }],
      })),
      readRuntime: vi.fn(),
    },
    taskStateDelivery: {
      listTaskIds: vi.fn(async () => [task.id]),
      readTasks: vi.fn(async () => [{ kind: "found" as const, task }]),
      readDeliveryEvidence: vi.fn(),
    },
    alertActuation: { readInboxEvidence: vi.fn() },
    ...overrides,
  };
}

describe("Coordination hidden-observation port characterization", () => {
  it("uses the injected hidden port with exact lead, epoch, and lineage, then commits before cache reuse and pending clear", async () => {
    const calls: string[] = [];
    const query = queries();
    const hidden = {
      schema: "pi-teams-hidden-observation/1" as const,
      teamEpochId: "epoch-1",
      exactSessionId: sessionFile,
      acknowledgedEntryId: "root",
      acknowledgedLineage: ["root"],
      teamEventCursor: "0",
      authorityRevisions: { task_projection: "baseline" },
      updatedAt: new Date(0).toISOString(),
    };
    let committed = false;
    const store = {
      readHidden: vi.fn(async (_team: string, coordinate: any) => {
        calls.push(`read:${coordinate.teamEpochId}:${coordinate.exactSessionId}:${coordinate.branchLineage.join(",")}`);
        return committed ? { kind: "found", projection: { ...hidden, acknowledgedEntryId: "snapshot", acknowledgedLineage: ["root", "snapshot"] } } : { kind: "found", projection: hidden };
      }),
      commitHidden: vi.fn(async (_team: string, input: any) => {
        calls.push(`commit:${input.teamEpochId}:${input.exactSessionId}:${input.branchLineage.join(",")}`);
        expect(service.pending(sessionFile)).toBeDefined();
        committed = true;
        return { kind: "committed", projection: { ...hidden, acknowledgedEntryId: input.acknowledgedEntryId, acknowledgedLineage: input.branchLineage, teamEventCursor: input.teamEventCursor } };
      }),
      readEvents: vi.fn(() => committed
        ? { events: [{ type: "worker", phase: "prepared", worker: "worker", cursor: "1" }], cursor: "1", headCursor: "1", truncated: false }
        : { events: [], cursor: "0", headCursor: "0", truncated: false }),
      readEventCursor: vi.fn(() => "0"),
      waitEvents: vi.fn(),
      readFailureHints: vi.fn(() => ({ hints: [], cursor: "0", headCursor: "0" })),
    };
    const service = new CoordinationObservationService(query, {
      projectNonterminalTaskIds: () => [],
      projectTaskChanges: () => ({ kind: "projected", changes: [] }),
    }, store as any);

    service.setBranchContext(sessionFile, ["root", "snapshot"]);
    await expect(service.readTeamSync(sessionFile, "snapshot", new AbortController().signal, "snapshot-call"))
      .resolves.toMatchObject({ kind: "snapshot", epochId: "epoch-1" });
    expect(service.pending(sessionFile)).toMatchObject({ epochId: "epoch-1", head: 0 });

    await expect(service.acknowledge(sessionFile, "snapshot", ["root", "snapshot"])).resolves.toBe(true);
    expect(calls).toContain(`commit:epoch-1:${sessionFile}:root,snapshot`);
    expect(service.pending(sessionFile)).toBeUndefined();

    await expect(service.readTeamSync(sessionFile, "updates", new AbortController().signal, "update-call"))
      .resolves.toMatchObject({ kind: "updates", head: 1, epochId: "epoch-1" });
    expect(query.taskStateDelivery.listTaskIds).toHaveBeenCalledTimes(1);
    expect(query.taskStateDelivery.readTasks).toHaveBeenCalledTimes(1);
  });

  it("preserves worker-run DTO parity through the injected query bundle", async () => {
    const query = queries({
      teamRuntime: { readRuntime: vi.fn(async () => ({ membershipId: "worker-1", pid: 42, startedAt: 7, runState: "active" as const })) },
      taskStateDelivery: {
        listTaskIds: vi.fn(async () => []),
        readTasks: vi.fn(async () => []),
        readDeliveryEvidence: vi.fn(async () => ({ known: true, pending: true })),
      },
      alertActuation: { readInboxEvidence: vi.fn(async () => ({ known: true, pending: false })) },
    });
    const member = { name: "worker", membershipId: "worker-1", sessionFile: "/sessions/worker.jsonl", isActive: true } as any;

    await expect(readWorkerRunObservation(teamName, member, query)).resolves.toEqual({
      worker: "worker", membershipId: "worker-1", generation: { membershipId: "worker-1", pid: 42, startedAt: 7 }, state: "active", actuationPending: true,
    });
    expect(query.teamRuntime.readRuntime).toHaveBeenCalledWith(teamName, member);
    expect(query.taskStateDelivery.readDeliveryEvidence).toHaveBeenCalledWith(teamName, "worker");
    expect(query.alertActuation.readInboxEvidence).toHaveBeenCalledWith(teamName, "worker");
  });

  it("keeps nudge eligibility separate from normal observation Worker requirements", async () => {
    const query = queries({
      teamRuntime: {
        readLeaderBinding: vi.fn(async () => ({
          teamName,
          epochId: "epoch-1",
          sessionFile,
          syncLiveness: { waitSeconds: 0, nudgeEnabled: true, nudgeDelaySeconds: 0, policyVersion: "test" },
          members: [{ name: "team-lead", agentType: "lead", membershipId: "lead-1", sessionFile, isActive: true }],
        })),
        readRuntime: vi.fn(),
      },
    });
    const service = new CoordinationObservationService(query, {
      projectNonterminalTaskIds: () => [],
      projectTaskChanges: () => ({ kind: "projected", changes: [] }),
    }, {
      readHidden: vi.fn(async () => ({ kind: "not_found" as const, reason: "absent" as const })),
      commitHidden: vi.fn(async () => ({ kind: "refused" as const, reason: "stale_acknowledgement" as const })),
      readEvents: vi.fn(() => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0 })),
      readEventCursor: vi.fn(() => "0"),
      waitEvents: vi.fn(async () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0, timedOut: true })),
      readFailureHints: vi.fn(() => ({ hints: [], cursor: "0", headCursor: "0" })),
    }, undefined, {
      readHidden: vi.fn(async () => ({ kind: "missing" as const })),
      readEvents: vi.fn(() => ({ events: [], cursor: "0", headCursor: "0", truncated: false })),
      readFailureHints: vi.fn(() => ({ hints: [], headCursor: "0" })),
    });

    await expect(service.readTeamSync(sessionFile, "snapshot", new AbortController().signal, "normal"))
      .resolves.toMatchObject({ kind: "unavailable", reason: "no_active_team" });
    await expect(service.readSyncNudgeDebt(sessionFile, ["root"])).resolves.toMatchObject({
      kind: "eligible", requestedView: "snapshot", teamEpochId: "epoch-1", leaderSessionId: sessionFile, leaderMembershipId: "lead-1", branchLineage: ["root"],
    });
  });

  it("keeps hidden persistence, DTO liveness, and nudge actuation on separate static boundaries", () => {
    const root = process.cwd();
    const source = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
    const observation = source("src/coordination/observation-service.ts");
    const queriesContract = source("src/coordination/queries.ts");
    const liveness = source("src/utils/sync-liveness.ts");
    const nudge = source("src/coordination/nudge-debt.ts");

    expect(observation).toContain("private readonly store: CoordinationObservationStore");
    expect(observation).toContain("this.store.readHidden");
    expect(observation).toContain("this.store.commitHidden");
    expect(observation).not.toMatch(/from ["'][^"']*(?:durable-model-tool|sync-nudge-conductor)[^"']*["']/);
    expect(queriesContract).not.toMatch(/(?:Member\b|AgentRuntimeStatus|InboxMessage|TaskAuthorityRecord)/);
    expect(liveness).toContain("queries.taskStateDelivery.readDeliveryEvidence");
    expect(liveness).toContain("queries.alertActuation.readInboxEvidence");
    expect(nudge).not.toMatch(/(?:sendMessage|reserve\(|present\(|SyncNudgeConductor)/);
  });
});
