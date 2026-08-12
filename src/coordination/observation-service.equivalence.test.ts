import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDurableCoordinationQueries } from "../adapters/durable-coordination-queries";
import { DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import type { TeamSyncPortResult } from "../model-tool-contract/model-tool-contracts";
import { CoordinationObservationService } from "./observation-service";
import { waitForLivenessHint } from "../utils/sync-liveness";
import { teamDir } from "../utils/paths";
import { composedDurableModelToolPort } from "../../test/support/durable-model-tool-port";
import { createReadOnlyBeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import type { CoordinationSyncResult } from "./observation-contracts";

function modelToolAlias(result: CoordinationSyncResult): TeamSyncPortResult {
  return result;
}

function coordinationAlias(result: TeamSyncPortResult): CoordinationSyncResult {
  return result;
}

describe("Coordination observation service equivalence fences", () => {
  it("keeps domain and model-tool sync result aliases structurally and at runtime compatible", () => {
    const result: CoordinationSyncResult = { kind: "caught_up", head: 7, epochId: "epoch-7" };
    expect(modelToolAlias(result)).toEqual(result);
    expect(coordinationAlias(modelToolAlias(result))).toEqual(result);
  });

  it("joins an abandoned authority check with final and later complete projections, then reads fresh", async () => {
    let release!: (ids: string[]) => void;
    let active = 0;
    let maximumActive = 0;
    const firstIds = new Promise<string[]>((resolve) => { release = resolve; });
    const listTaskIds = vi.fn()
      .mockImplementationOnce(async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        try { return await firstIds; } finally { active--; }
      })
      .mockResolvedValueOnce([]);
    const service = new CoordinationObservationService({
      teamRuntime: { readRuntime: vi.fn() },
      taskStateDelivery: {
        listTaskIds,
        readTasks: vi.fn(async () => []),
        readDeliveryEvidence: vi.fn(),
      },
      alertActuation: { readInboxEvidence: vi.fn() },
    }, {
      projectNonterminalTaskIds: () => [],
      projectTaskChanges: () => ({ kind: "projected", changes: [] }),
    }, {
      readHidden: async () => ({ kind: "not_found", reason: "absent" }),
      commitHidden: async () => ({ kind: "refused", reason: "stale_acknowledgement" }),
      readEvents: () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0 }),
      readEventCursor: () => "0",
      waitEvents: async () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0, timedOut: true }),
      readFailureHints: () => ({ hints: [], cursor: "0", headCursor: "0" }),
    });

    // A timed-out or cancelled liveness waiter no longer awaits this check,
    // but its read remains live. The final check and a later sync must join it.
    const abandonedAuthorityCheck = service.readTaskProjection("team-a");
    const finalProjection = service.readTaskProjection("team-a");
    const laterProjection = service.readTaskProjection("team-a");
    expect(listTaskIds).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(1);
    release([]);
    await expect(Promise.all([abandonedAuthorityCheck, finalProjection, laterProjection])).resolves.toEqual([
      { kind: "tasks", tasks: [], warnings: [] },
      { kind: "tasks", tasks: [], warnings: [] },
      { kind: "tasks", tasks: [], warnings: [] },
    ]);

    await expect(service.readTaskProjection("team-a")).resolves.toEqual({ kind: "tasks", tasks: [], warnings: [] });
    expect(listTaskIds).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
  });

  it("keeps an authority read alive across real wait timeout and cancellation until final reads join it", async () => {
    vi.useFakeTimers();
    const teamName = `single-flight-wait-${process.pid}`;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let reads = 0;
    let active = 0;
    let maximumActive = 0;
    const unresolved = () => new Promise<string[]>((resolve) => {
      if (reads === 1) releaseFirst = () => resolve([]);
      else releaseSecond = () => resolve([]);
    });
    const service = new CoordinationObservationService({
      teamRuntime: { readRuntime: vi.fn() },
      taskStateDelivery: {
        listTaskIds: vi.fn(() => {
          reads++;
          if (reads === 3) return Promise.resolve([]);
          active++;
          maximumActive = Math.max(maximumActive, active);
          return unresolved().finally(() => { active--; });
        }),
        readTasks: vi.fn(async () => []),
        readDeliveryEvidence: vi.fn(),
      },
      alertActuation: { readInboxEvidence: vi.fn() },
    }, {
      projectNonterminalTaskIds: () => [],
      projectTaskChanges: () => ({ kind: "projected", changes: [] }),
    }, {
      readHidden: async () => ({ kind: "not_found", reason: "absent" }),
      commitHidden: async () => ({ kind: "refused", reason: "stale_acknowledgement" }),
      readEvents: () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0 }),
      readEventCursor: () => "0",
      waitEvents: async () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0, timedOut: true }),
      readFailureHints: () => ({ hints: [], cursor: "0", headCursor: "0" }),
    });
    try {
      const timedOut = waitForLivenessHint({ teamName, waitMs: 10, check: () => false, checkAuthority: async () => { await service.readTaskProjection(teamName); return false; } });
      await Promise.resolve();
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      await expect(timedOut).resolves.toBe("timeout");
      const finalAfterTimeout = service.readTaskProjection(teamName);
      expect(reads).toBe(1);
      releaseFirst();
      await expect(finalAfterTimeout).resolves.toEqual({ kind: "tasks", tasks: [], warnings: [] });

      const controller = new AbortController();
      const cancelled = waitForLivenessHint({ teamName, waitMs: 10_000, signal: controller.signal, check: () => false, checkAuthority: async () => { await service.readTaskProjection(teamName); return false; } });
      await Promise.resolve();
      expect(reads).toBe(2);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      const finalAfterCancellation = service.readTaskProjection(teamName);
      expect(reads).toBe(2);
      releaseSecond();
      await expect(finalAfterCancellation).resolves.toEqual({ kind: "tasks", tasks: [], warnings: [] });
      await expect(service.readTaskProjection(teamName)).resolves.toEqual({ kind: "tasks", tasks: [], warnings: [] });
      expect(reads).toBe(3);
      expect(maximumActive).toBe(1);
    } finally {
      fs.rmSync(teamDir(teamName), { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("keeps branch, pending, cache, and acknowledgement ownership in one Coordination service", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/coordination/observation-service.ts"), "utf8");
    expect(source).toContain("private readonly branchLineages");
    expect(source).toContain("private readonly pendingBySession");
    expect(source).toContain("private readonly taskProjections");
    expect(source).toContain("async acknowledge(exactSessionFile");
    expect(source).toContain("commitHidden");
    expect(source).toContain("cachedProjectionForBound");
  });

  it("keeps the Coordination application as the observation-service delegate without a copied algorithm", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/durable-model-tool-coordination-application.ts"), "utf8");
    expect(source).toContain("this.service.readTeamSync(file, view, signal, call)");
    expect(source).toContain("this.service.acknowledge(");
    expect(source).toContain("this.service.setBranchContext(");
    expect(source).toContain("this.service.pending(");
    expect(source).toContain("this.service.readSyncNudgeDebt(file, lineage)");
    expect(source).not.toContain("readModelToolTasks(");
    expect(source).not.toContain("hydrateTaskIds(");
    expect(source).not.toContain("cachedTaskProjection(");
  });

  it("keeps the flat durable port as an exact Coordination forwarder", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/durable-model-tool-port.ts"), "utf8");
    expect(source).toContain("return this.coordination.readTeamSync(...args);");
    expect(source).toContain("return this.coordination.acknowledgePendingObservation(...args);");
    expect(source).toContain("return this.coordination.acknowledgePendingObservationAsync(...args);");
    expect(source).toContain("return this.coordination.setBranchContext(...args);");
    expect(source).toContain("return this.coordination.getPendingObservation(...args);");
    expect(source).toContain("return this.coordination.readSyncNudgeDebt(...args);");
    expect(source).not.toContain("observationService.readTeamSync");
    expect(source).not.toContain("observationService.acknowledge");
  });

  it("fences Coordination imports and requires an injected durable store", () => {
    const root = process.cwd();
    const source = fs.readFileSync(path.join(root, "src/coordination/observation-service.ts"), "utf8");
    expect(source).not.toMatch(/from ["'][^"']*(?:model-tool-contract|trio)[^"']*["']/);
    expect(() => composedDurableModelToolPort()).not.toThrow();
    const factory = createReadOnlyBeadsTaskAdapterFactory({
      readTaskAuthorityRecordEnvelope: async () => undefined as any,
      readTaskAuthorityRecordEnvelopes: async () => [],
      listTaskIds: async () => [],
    });
    expect(() => new CoordinationObservationService(createDurableCoordinationQueries(factory), {
      projectNonterminalTaskIds: () => [],
      projectTaskChanges: () => ({ kind: "projected", changes: [] }),
    }, {
      readHidden: async () => ({ kind: "not_found", reason: "absent" }),
      commitHidden: async () => ({ kind: "refused", reason: "stale_acknowledgement" }),
      readEvents: () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0 }),
      readEventCursor: () => "0",
      waitEvents: async () => ({ events: [], cursor: "0", headCursor: "0", truncated: false, remaining: 0, timedOut: true }),
      readFailureHints: () => ({ hints: [], cursor: "0", headCursor: "0" }),
    })).not.toThrow();
  });
});
