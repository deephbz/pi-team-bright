import { Check } from "typebox/value";
import { DeliveryDegradedSchema } from "./catalog";
import { describe, expect, it } from "vitest";
import { nodeHostEnv, runWithHostEnv } from "../env/host-env";
import { formatCarrierStatus } from "../utils/team-status";
import { projectToolTuiMessage } from "./tui-projection";
import { assembleToolResult, TeamSyncModelResultSchema } from "./result-projection";
import type { DeliveryDegradation } from "../utils/recipient-delivery-lifecycle";

describe("human delivery retry time", () => {
  it("validates terminal degradation and shows no automatic retry in status, Alert receipts and both Team views", () => {
    const failure: DeliveryDegradation = { engine: "task", operation: "start", message: "Unsupported Task storage", observedAt: 500 };
    expect(Check(DeliveryDegradedSchema, [failure])).toBe(true);
    expect(JSON.stringify(DeliveryDegradedSchema)).toContain("Absence means no automatic retry");
    const status = formatCarrierStatus({ worker: "worker", membership: "member-1", binding: "bound", launch: "none", process: "live", terminal: "present", activity: "idle", evidence: [], deliveryDegraded: [failure] }).line;
    expect(status).toContain("task delivery stopped");
    expect(status).toContain("no automatic retry");
    const receipt = { kind: "alert_sent" as const, alert_id: "alert-1", accepted_recipients: ["worker"], failed_recipients: [], task_state_changed: false as const, delivery_degraded: [{ recipient: "worker", engines: [failure] }] };
    const model = JSON.parse(assembleToolResult("alert_send", receipt).content[0].text);
    expect(model.delivery_degraded[0].engines[0]).not.toHaveProperty("retryAt");
    const tui = projectToolTuiMessage({ tool: "alert_send", details: receipt, expanded: false }).body!.join("\n");
    expect(tui).toContain("task delivery stopped");
    expect(tui).toContain("no automatic retry");
    for (const details of [
      { kind: "snapshot", team: { name: "team", purpose: "Test", lifecycle: "active" }, workers: [{ name: "worker", scope: "Test", carrier: "connected", nonterminal_task_ids: [], delivery_degraded: [failure] }], tasks: [], alerts: [], alerts_omitted: 0 },
      { kind: "unsettled", head: 0, epoch_id: "epoch-1", workers: [{ name: "worker", reason: "delivery_degraded", delivery_degraded: [failure] }] },
    ]) {
      expect(Check(TeamSyncModelResultSchema, details)).toBe(true);
      const rendered = projectToolTuiMessage({ tool: "team_sync", details, expanded: false }).body!.join("\n");
      expect(rendered).toContain("task delivery stopped");
      expect(rendered).toContain("no automatic retry");
      expect(rendered).not.toContain("retry scheduled");
    }
  });
  it.each([{ retryAt: 4500, text: "retry in 4 s" }, { retryAt: 4000, text: "retry in 3 s" }, { retryAt: 1000, text: "retry due now" }, { retryAt: 500, text: "retry due now" }])("renders $retryAt as $text without changing model evidence", ({ retryAt, text }) => {
    runWithHostEnv({ ...nodeHostEnv, clock: { ...nodeHostEnv.clock, now: () => 1000 } }, () => {
      const failure: DeliveryDegradation = { engine: "alert", operation: "scan", message: "Storage unavailable", observedAt: 500, retryAt };
      const details = { kind: "alert_sent" as const, alert_id: "alert-1", accepted_recipients: ["worker"], failed_recipients: [], task_state_changed: false as const,
        delivery_degraded: [{ recipient: "worker", engines: [failure] }] };
      const tui = projectToolTuiMessage({ tool: "alert_send", details, expanded: false }).body!.join("\n");
      expect(tui).toContain(text);
      expect(tui).not.toContain("retry at");
      const status = formatCarrierStatus({ worker: "worker", membership: "member-1", binding: "bound", launch: "none", process: "live", terminal: "present", activity: "idle", evidence: [], deliveryDegraded: [failure] }).line;
      expect(status).toContain(text);
      expect(status).not.toContain("retryAt=");
      const model = JSON.parse(assembleToolResult("alert_send", details).content[0].text);
      expect(model.delivery_degraded[0].engines[0].retryAt).toBe(retryAt);
      expect(model).not.toHaveProperty("acceptance");
    });
  });
});
