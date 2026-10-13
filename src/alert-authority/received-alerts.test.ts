import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_KINDS, deliveryText, parseAlertDeliveryText, readRecentReceivedAlerts, sendAlert } from "./alerts";
import type { AlertMembershipPort, AlertTaskReference } from "./contracts";
import { inboxPath, teamDir } from "../utils/paths";
import { CoordinationObservationService } from "../coordination/observation-service";
import { snapshotEntry } from "../../test/support/branch-observation";
import type { TeamEvent } from "../coordination/contracts";

const team = "received-alert-recovery";
const file = "/sessions/lead.jsonl";
const version = "v_0123456789abcdef" as const;
let members: Map<string, string>;
let refused: Set<string>;
const publication = { appendAcceptedAlert: vi.fn(async () => ({ cursor: "0" })) };
const membership: AlertMembershipPort = {
  currentRecipients: async (_team, excluding) => ({ kind: "current", recipients: [...members.keys()].filter(name => name !== excluding).map(name => ({ name })) }),
  withCurrentDelivery: async (input, append) => {
    const recipientMembershipId = members.get(input.to);
    if (!recipientMembershipId || refused.has(input.to)) return { kind: "recipient_absent" };
    return { kind: "delivered", value: await append({ recipientMembershipId, senderMembershipId: members.get(input.from) }) };
  },
  isCurrentSessionBinding: async () => true,
};
const send = (text: string, to = "team-lead") => sendAlert({ teamName: team, from: "worker-a", to, kind: "attention", text }, membership, publication);

function snapshotFixture() {
  const received = vi.fn(readRecentReceivedAlerts);
  const events: TeamEvent[] = [];
  const service = new CoordinationObservationService({
    teamRuntime: {
      readLeaderBinding: async session => session === file ? { teamName: team, epochId: "epoch", sessionFile: file, logicalWorkers: [{ name: "worker-a", scope: "Test received Alerts" }], members: [{ name: "team-lead", agentType: "lead", membershipId: members.get("team-lead"), sessionFile: file, isActive: true }] } : undefined,
      readRuntime: async () => null,
    },
    taskStateDelivery: { listTaskIds: async () => [], readTasks: async () => [], readDeliveryEvidence: async () => ({ known: true, pending: false }) },
    alertActuation: { readInboxEvidence: async () => ({ known: true, pending: false }) },
    receivedAlerts: { readRecentReceivedAlerts: received },
  }, { projectNonterminalTaskIds: () => [], projectTaskChanges: () => ({ kind: "projected", changes: [] }) }, {
    readEventCursor: () => String(events.length),
    readEvents: () => ({ events, cursor: String(events.length), headCursor: String(events.length), truncated: false, remaining: 0 }),
  });
  return { service, received, events, snapshot: () => service.readSnapshot(file) };
}

beforeEach(() => {
  members = new Map([["team-lead", "membership-lead"], ["worker-a", "membership-a"], ["worker-b", "membership-b"]]);
  refused = new Set();
  publication.appendAcceptedAlert.mockReset().mockResolvedValue({ cursor: "0" });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(teamDir(team), { recursive: true, force: true }); });

describe("received Alert recovery", () => {
  it.each(ALERT_KINDS)("round-trips %s envelopes with Task references, multiline and Unicode bodies", kind => {
    const refs: Array<AlertTaskReference | undefined> = [undefined, { taskId: "task-a" }, { taskId: "task-a", version }];
    for (const taskRef of refs) for (const text of ["Check scope.", "First line\nSecond line\n", "🧭 确认\nDecision: proceed ✅"]) {
      expect(parseAlertDeliveryText(deliveryText("alert_example", kind, text, taskRef))).toEqual({ alertId: "alert_example", kind, text, ...(taskRef ? { taskRef } : {}) });
    }
    expect(parseAlertDeliveryText("ordinary inbox message")).toBeUndefined();
    expect(parseAlertDeliveryText(deliveryText("alert_example", kind, "body", undefined).replace(/Task\.$/, "broken trailer"))).toBeUndefined();
  });

  it("returns newest 10 of 12 received Alerts in inbox order and counts two omitted", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await send(`Alert ${i}`)).alertId);
    // Receipt order must survive a clock moving backwards.
    const inbox = inboxPath(team, "team-lead");
    const rows = JSON.parse(fs.readFileSync(inbox, "utf8"));
    rows[11].timestamp = "2000-01-01T00:00:00Z";
    fs.writeFileSync(inbox, JSON.stringify(rows));
    const fx = snapshotFixture();
    const result = await fx.snapshot();
    expect(result).toMatchObject({ kind: "snapshot", alertsOmitted: 2, alerts: ids.slice(2).reverse().map(alertId => ({ alertId })) });
    expect(result.kind === "snapshot" && result.alerts).toHaveLength(10);
    expect(fx.received).toHaveBeenCalledExactlyOnceWith(team, "team-lead", "membership-lead", 10);
    expect(await fx.service.readSnapshot("/sessions/foreign.jsonl")).toEqual({ kind: "no_active_team" });
    expect(fx.received).toHaveBeenCalledTimes(1);
  });

  it("cuts at 2000 Unicode code points and reports the full length before a decisive suffix", async () => {
    const text = "a".repeat(1999) + "🧭" + " STOP: do not release.";
    await sendAlert({ teamName: team, from: "worker-a", to: "team-lead", kind: "clarification", text, taskId: "task-a", taskVersion: version }, membership, publication);
    const result = await snapshotFixture().snapshot();
    expect(result).toMatchObject({ kind: "snapshot", alerts: [{ text: "a".repeat(1999) + "🧭", truncated: true, textLength: Array.from(text).length, taskId: "task-a", taskVersion: version }] });
    if (result.kind !== "snapshot") throw new Error("Snapshot unavailable");
    expect(Array.from(result.alerts[0]!.text)).toHaveLength(2000);
    expect(result.alerts[0]!.text.endsWith("🧭")).toBe(true);
    expect(result.alerts[0]!.text).not.toContain("STOP");
  });

  it("excludes another member and replaced same-name Membership from the snapshot", async () => {
    await send("Previous lead");
    members.set("team-lead", "membership-lead-replacement");
    await send("Other member", "worker-b");
    const accepted = await send("Current lead");
    expect(await snapshotFixture().snapshot()).toMatchObject({ kind: "snapshot", alerts: [{ alertId: accepted.alertId, text: "Current lead" }], alertsOmitted: 0 });
    expect((await readRecentReceivedAlerts(team, "team-lead", "membership-lead-replacement", 10)).alerts).toHaveLength(1);
  });

  it("excludes the sender's own broadcast and includes partial broadcast only for accepted recipients", async () => {
    refused.add("worker-b");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sent = await sendAlert({ teamName: team, from: "team-lead", to: "*", kind: "announcement", text: "Review the changed constraint." }, membership, publication);
    expect(sent.accepted.map(row => row.recipient)).toEqual(["worker-a"]);
    expect(sent.failures.map(row => row.recipient)).toEqual(["worker-b"]);
    expect(await snapshotFixture().snapshot()).toMatchObject({ kind: "snapshot", alerts: [], alertsOmitted: 0 });
    expect(await readRecentReceivedAlerts(team, "worker-a", "membership-a", 10)).toMatchObject({ alerts: [{ alertId: sent.alertId }], omitted: 0 });
    expect(await readRecentReceivedAlerts(team, "worker-b", "membership-b", 10)).toEqual({ alerts: [], omitted: 0 });
  });

  it("recovers an accepted Alert even when its journal append failed", async () => {
    publication.appendAcceptedAlert.mockRejectedValueOnce(new Error("journal append failed"));
    await expect(send("Accepted before journal failure")).rejects.toThrow("journal append failed");
    const fx = snapshotFixture();
    const snapshot = await fx.service.readTeamSync(file, "snapshot", new AbortController().signal, "read");
    expect(snapshot).toMatchObject({ kind: "snapshot", head: 0, alerts: [{ text: "Accepted before journal failure" }] });
    fx.service.clearPending(file);
  });

  it("leaves inbox bytes and all read flags unchanged after snapshot, skipping id-less and unscoped legacy rows", async () => {
    await send("Delivered history"); await send("Pending delivery");
    const inbox = inboxPath(team, "team-lead");
    const rows = JSON.parse(fs.readFileSync(inbox, "utf8"));
    rows[0].read = true;
    rows.push({ ...rows[0], id: undefined }, { ...rows[1], recipientMembershipId: undefined }, { ...rows[0], id: "ordinary", text: "not an Alert" });
    fs.writeFileSync(inbox, JSON.stringify(rows, null, 3));
    const before = fs.readFileSync(inbox);
    const fx = snapshotFixture();
    const result = await fx.snapshot();
    expect(result.kind === "snapshot" && result.alerts).toHaveLength(2);
    expect(fs.readFileSync(inbox)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(inbox, "utf8")).map((row: any) => row.read)).toEqual(rows.map((row: any) => row.read));
  });

  it("fails unavailable instead of claiming no Alerts when the inbox cannot be decoded", async () => {
    const inbox = inboxPath(team, "team-lead");
    fs.mkdirSync(path.dirname(inbox), { recursive: true }); fs.writeFileSync(inbox, "not json");
    expect(await snapshotFixture().snapshot()).toMatchObject({ kind: "unavailable", reason: "team_state_unavailable" });
  });

  it("keeps updates.alerts empty and does not read the inbox during incremental observation", async () => {
    await send("Already delivered directly");
    const fx = snapshotFixture();
    fx.service.setBranchEntries(file, [snapshotEntry("base", team, "epoch", "membership-lead", [])]);
    fx.events.push({ type: "worker", worker: "worker-a", membershipId: "membership-a", phase: "prepared", cursor: "1", at: "2026-10-13T00:00:00Z" });
    const result = await fx.service.readTeamSync(file, "updates", new AbortController().signal, "read");
    expect(result).toMatchObject({ kind: "updates", alerts: [] });
    expect(fx.received).not.toHaveBeenCalled();
    fx.service.clearPending(file);
  });
});
