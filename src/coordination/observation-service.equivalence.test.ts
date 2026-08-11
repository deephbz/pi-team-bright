import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDurableCoordinationQueries } from "../adapters/durable-coordination-queries";
import { DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import type { TeamSyncPortResult } from "../model-tool-contract/model-tool-contracts";
import { CoordinationObservationService } from "./observation-service";
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
