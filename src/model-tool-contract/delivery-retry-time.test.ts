import { describe, expect, it } from "vitest";
import { nodeHostEnv, runWithHostEnv } from "../env/host-env";
import { formatCarrierStatus } from "../utils/team-status";
import { projectToolTuiMessage } from "./tui-projection";
import { assembleToolResult } from "./result-projection";
import type { DeliveryDegradation } from "../utils/recipient-delivery-lifecycle";

describe("human delivery retry time", () => {
  it.each([[4500, 4], [4000, 3], [500, 0]])("renders retryAt=%s as retry in %s s without changing model evidence", (retryAt, seconds) => {
    runWithHostEnv({ ...nodeHostEnv, clock: { ...nodeHostEnv.clock, now: () => 1000 } }, () => {
      const failure: DeliveryDegradation = { engine: "alert", operation: "scan", message: "Storage unavailable", observedAt: 500, retryAt };
      const details = { kind: "alert_sent" as const, alert_id: "alert-1", accepted_recipients: ["worker"], failed_recipients: [], task_state_changed: false as const,
        delivery_degraded: [{ recipient: "worker", engines: [failure] }] };
      const tui = projectToolTuiMessage({ tool: "alert_send", details, expanded: false }).body!.join("\n");
      expect(tui).toContain(`retry in ${seconds} s`);
      expect(tui).not.toContain("retry at");
      const status = formatCarrierStatus({ worker: "worker", membership: "member-1", binding: "bound", launch: "none", process: "live", terminal: "present", activity: "idle", evidence: [], deliveryDegraded: [failure] }).line;
      expect(status).toContain(`retry in ${seconds} s`);
      expect(status).not.toContain("retryAt=");
      const model = JSON.parse(assembleToolResult("alert_send", details).content[0].text);
      expect(model.delivery_degraded[0].engines[0].retryAt).toBe(retryAt);
      expect(model).not.toHaveProperty("acceptance");
    });
  });
});
