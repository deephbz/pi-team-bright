import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DurableCoordinationNudgeRecord } from "../adapters/durable-coordination-nudge-record";
import { CoordinationObservationService } from "./observation-service";
import { composedDurableModelToolPort } from "../../test/support/durable-model-tool-port";

const root = process.cwd();
const source = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("Coordination automatic sync boundary", () => {
  it("keeps the model-tool facade as a Coordination debt and probe delegate", () => {
    const port = source("src/model-tool-contract/durable-model-tool-port.ts");
    expect(port).toContain("return this.coordination.readSyncNudgeDebt(...args);");
    expect(port).toContain("return this.coordination.peekTeamSync(...args);");
    expect(() => composedDurableModelToolPort()).not.toThrow();
  });

  it("derives debt from the shared canonical nonblocking probe", () => {
    const debt = source("src/coordination/nudge-debt.ts");
    const observation = source("src/coordination/observation-service.ts");
    const store = source("src/adapters/durable-coordination-nudge-store.ts");
    expect(debt).toContain("this.probe.peekTeamSync(bound.sessionFile, requestedView, branchLineage)");
    expect(debt).toContain("projection.updateCount === 0");
    expect(debt).toContain("scopeKey: projection.scopeKey");
    expect(debt).not.toContain("readTaskProjection");
    expect(debt).not.toContain("readEvents");
    expect(observation).toContain("async peekTeamSync(");
    expect(observation).toContain("No result or cursor is staged");
    expect(store).toContain("hidden.read");
    expect(store).not.toContain("readTaskEventFailureHintsAfter");
    expect(CoordinationObservationService).toBeTypeOf("function");
  });

  it("keeps the deadline in the scheduler and publication in the Pi adapter", () => {
    const conductor = source("src/utils/sync-nudge-conductor.ts");
    const pi = source("extensions/pi-team-session-adapter.ts");
    expect(conductor).toContain("this.armedScopeKey = debt.scopeKey");
    expect(conductor).toContain("const published = await this.dependencies.present(debt)");
    expect(conductor).not.toContain("readSyncNudgeDebt");
    expect(pi).toContain("teamQuery.matchesSyncNudgeCandidate");
    expect(pi).toContain("latest.debtKey !== candidate.debtKey");
    expect(pi).toContain("latest.scopeKey !== candidate.scopeKey");
    expect(pi).toContain('const result = await frameworkSync.execute(teamName!, "automatic", candidate.requestedView, candidate.debtKey)');
    expect(pi).toContain('return result === "published"');
    expect(() => new DurableCoordinationNudgeRecord()).not.toThrow();
  });
});
