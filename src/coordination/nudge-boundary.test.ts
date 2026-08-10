import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DurableModelToolTeamPort } from "../model-tool-contract/durable-model-tool-port";
import { DurableCoordinationNudgeRecord } from "../adapters/durable-coordination-nudge-record";
import { CoordinationObservationService } from "./observation-service";

const root = process.cwd();

describe("Coordination nudge boundary", () => {
  it("keeps the facade as a nudge-debt delegate with legacy construction", () => {
    const source = fs.readFileSync(path.join(root, "src/model-tool-contract/durable-model-tool-port.ts"), "utf8");
    expect(source).toContain("this.observationService.readSyncNudgeDebt(sessionFile, branchLineage)");
    expect(source).not.toContain("readAllNudgeEvents");
    expect(source).not.toContain("readTaskEventFailureHintsAfter");
    expect(() => new DurableModelToolTeamPort()).not.toThrow();
  });

  it("keeps debt provenance in Coordination and timer plus Pi record persistence outside it", () => {
    const debt = fs.readFileSync(path.join(root, "src/coordination/nudge-debt.ts"), "utf8");
    const conductor = fs.readFileSync(path.join(root, "src/utils/sync-nudge-conductor.ts"), "utf8");
    const pi = fs.readFileSync(path.join(root, "extensions/pi-team-session-adapter.ts"), "utf8");
    expect(debt).toContain("export interface CoordinationNudgeTaskProjectionReader");
    expect(debt).toContain("export interface CoordinationNudgeStore");
    expect(debt).toContain("private readonly taskProjectionReader: CoordinationNudgeTaskProjectionReader");
    expect(debt).toContain('taskVersion: task.version');
    expect(debt).not.toMatch(/from ["'][^"']*(?:observation-service|hidden-observation|team-events|task-event-failure-hints|task-version-ref)["']/);
    expect(debt).toContain("Team nudge event pagination did not advance.");
    expect(debt).toContain("Failed-event hint evidence is unavailable");
    expect(conductor).not.toMatch(/from ["'][^"']*(?:sync-nudge|durable-model-tool-port|team-events)[^"']*["']/);
    expect(pi).toContain("nudgeRecords.reserve(record)");
    expect(pi).toContain("syncNudgeMessageDelivered(ctx, presented)");
    expect(pi).toContain("nudgeRecords.present(record, presented.presentedAt)");
    expect(() => new DurableCoordinationNudgeRecord()).not.toThrow();
    const revision = fs.readFileSync(path.join(root, "src/coordination/task-projection-revision.ts"), "utf8");
    const durableStore = fs.readFileSync(path.join(root, "src/adapters/durable-coordination-nudge-store.ts"), "utf8");
    expect(revision).toContain('createHash("sha256")');
    expect(durableStore).toContain("readHiddenObservationProjection");
    expect(durableStore).toContain("readTaskEventFailureHintsAfter");
    expect(CoordinationObservationService).toBeTypeOf("function");
  });
});
