import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDurableCoordinationQueries } from "../adapters/durable-coordination-queries";
import { DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import type { TeamSyncPortResult } from "../model-tool-contract/in-memory-team-port";
import { CoordinationObservationService } from "./observation-service";
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

  it("keeps the model-tool facade as a service delegate without a copied observation algorithm", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/durable-model-tool-port.ts"), "utf8");
    expect(source).toContain("await this.observationService.readTeamSync(sessionFile, view, signal, toolCallId)");
    expect(source).toContain("this.observationService.acknowledge(");
    expect(source).toContain("this.observationService.setBranchContext(");
    expect(source).not.toContain("readModelToolTasks(");
    expect(source).not.toContain("hydrateTaskIds(");
    expect(source).not.toContain("cachedTaskProjection(");
  });

  it("fences Coordination imports and preserves default construction compatibility", () => {
    const root = process.cwd();
    const source = fs.readFileSync(path.join(root, "src/coordination/observation-service.ts"), "utf8");
    expect(source).not.toMatch(/from ["'][^"']*(?:model-tool-contract|trio)[^"']*["']/);
    expect(() => new DurableModelToolTeamPort()).not.toThrow();
    expect(() => new CoordinationObservationService(createDurableCoordinationQueries(), {
      projectNonterminalTaskIds: () => [],
      projectTaskChanges: () => ({ kind: "projected", changes: [] }),
    })).not.toThrow();
  });
});
