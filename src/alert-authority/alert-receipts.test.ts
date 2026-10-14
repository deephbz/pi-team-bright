import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertSender } from "./alerts";
import { readInboxForMembership } from "./inbox-delivery";
import { DurableAlertMembership } from "../adapters/durable-alert-membership";
import { TeamSessionLifecycleService } from "../team-authority/team-session-lifecycle-service";
import { DurableModelToolAlertApplication } from "../model-tool-contract/durable-model-tool-alert-application";
import { createModelToolJourneyExecutors } from "../model-tool-contract/executors";
import { ALERT_ACCEPTANCE_DESCRIPTION, AlertSendResultSchema } from "../model-tool-contract/catalog";
import { assembleToolResult, ModelResultSchemas } from "../model-tool-contract/result-projection";
import { projectToolTuiMessage } from "../model-tool-contract/tui-projection";
import * as runtime from "../utils/runtime";
import * as teams from "../utils/teams";
import * as paths from "../utils/paths";

const team = "alert-receipt-fixture", sessionFile = "/sessions/worker.jsonl";
const membership = new DurableAlertMembership();
const sender = createAlertSender(membership, { appendAcceptedAlert: async () => ({ cursor: "1" }) });
const binding = { teamName: team, recipient: "worker", membershipId: "member-worker", sessionFile };
let config: Awaited<ReturnType<typeof teams.readConfig>>;
beforeEach(async () => {
  await teams.createTeam(team, "/sessions/lead.jsonl", "lead-agent", "Test Alert receipts");
  await teams.addMember(team, { membershipId: binding.membershipId, agentId: "worker-agent", name: "worker", agentType: "teammate", joinedAt: 1, tmuxPaneId: "", sessionFile, cwd: "/project", subscriptions: [] });
  config = await teams.readConfig(team);
  await runtime.writeRuntimeStatus(team, "worker", { pid: process.pid, startedAt: 1, ...runtime.ownBirthIdentity() }, binding.membershipId);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(paths.teamDir(team), { recursive: true, force: true });
  fs.rmSync(paths.taskDir(team), { recursive: true, force: true });
});
async function degrade(engine: "alert" | "task") {
  await new TeamSessionLifecycleService({} as never).writeDeliveryState(binding, engine, {
    state: "degraded", engine, operation: "start", message: "Transient storage failure", observedAt: 10, retryAt: 1010,
  }, () => true);
}
function executor() {
  const alert = new DurableModelToolAlertApplication({ boundTeam: async () => ({ teamName: team, config, sessionFile: "/sessions/lead.jsonl" }) } as never, sender);
  return createModelToolJourneyExecutors({ alert } as never);
}

describe("Alert acceptance receipts", () => {
  it.each(["healthy", "alert", "task"] as const)("reports durable acceptance with %s delivery", async state => {
    if (state !== "healthy") await degrade(state);
    const result = await executor().alertSend("lead" as never, { to: "worker", kind: "attention", text: "Inspect the evidence." });
    expect(result).toMatchObject({ kind: "alert_sent", accepted_recipients: ["worker"], failed_recipients: [], task_state_changed: false });
    const assembled = assembleToolResult("alert_send", result);
    const text = JSON.stringify(assembled.content);
    expect(text).not.toContain('"acceptance"');
    expect(text).not.toContain(ALERT_ACCEPTANCE_DESCRIPTION);
    expect(JSON.stringify(AlertSendResultSchema)).toContain(ALERT_ACCEPTANCE_DESCRIPTION);
    expect(JSON.stringify(ModelResultSchemas.alert_send)).toContain(ALERT_ACCEPTANCE_DESCRIPTION);
    const tui = projectToolTuiMessage({ tool: "alert_send", details: result, expanded: false }).body!.join("\n");
    expect(tui).toContain("Task state unchanged");
    expect(tui).toContain("Presentation and processing are unconfirmed");
    if (state === "healthy") {
      expect(result).not.toHaveProperty("delivery_degraded");
      expect(tui).not.toContain("degraded");
    } else {
      expect(result).toMatchObject({ delivery_degraded: [{ recipient: "worker", engines: [{ engine: state, operation: "start", message: "Transient storage failure", retryAt: 1010 }] }] });
      expect(text).toContain("Transient storage failure");
      expect(tui).toContain(`${state} delivery degraded`);
    }
    const inbox = await readInboxForMembership(team, "worker", binding.membershipId, false, false);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).not.toHaveProperty("deliveryDegraded");
  });

  it("includes diagnostic evidence in broadcast receipts", async () => {
    await degrade("alert");
    const result = await sender.sendAlert({ teamName: team, from: "team-lead", to: "*", kind: "announcement", text: "Inspect delivery." });
    expect(result.accepted.map(item => item.recipient)).toEqual(["worker"]);
    expect(result.deliveryDegraded).toMatchObject([{ recipient: "worker", engines: [{ engine: "alert" }] }]);
  });

  it("accepts when runtime evidence cannot be read", async () => {
    vi.spyOn(runtime, "readRuntimeStatus").mockRejectedValue(new Error("diagnostic unavailable"));
    const result = await sender.sendAlert({ teamName: team, from: "team-lead", to: "worker", kind: "attention", text: "Read later." });
    expect(result.accepted).toHaveLength(1);
    expect(result.deliveryDegraded).toBeUndefined();
  });

  it("does not report stopped-generation degradation as current", async () => {
    await degrade("alert");
    await runtime.writeRuntimeStatus(team, "worker", { lastStop: { piReason: "quit", observedAt: 20, suspectedHumanStop: false } }, binding.membershipId);
    const result = await sender.sendAlert({ teamName: team, from: "team-lead", to: "worker", kind: "attention", text: "Read after recovery." });
    expect(result.accepted).toHaveLength(1);
    expect(result.deliveryDegraded).toBeUndefined();
  });
});
