import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./messaging", () => ({
  sendPlainMessage: vi.fn(),
  broadcastMessage: vi.fn(),
}));

vi.mock("./team-events", () => ({
  appendTeamEvent: vi.fn(),
}));

import * as messaging from "./messaging";
import { appendTeamEvent } from "./team-events";
import { sendAlert } from "./alerts";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";

describe("typed Alert acceptance", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(appendTeamEvent).mockResolvedValue({
      type: "alert",
      cursor: "7",
      alertId: "ignored",
      from: "team-lead",
      to: "worker",
      kind: "attention",
      text: "review",
      at: "2026-07-17T00:00:00.000Z",
    });
  });

  it("delivers one Task-scoped Alert to the exact native recipient then publishes its Team event", async () => {
    vi.mocked(messaging.sendPlainMessage).mockResolvedValue({
      id: "message_1",
      recipientMembershipId: "membership_worker",
      senderMembershipId: "membership_lead",
      from: "team-lead",
      text: "rendered",
      timestamp: "2026-07-17T00:00:00.000Z",
      read: false,
    });

    const result = await sendAlert({
      teamName: "dogfood",
      from: "team-lead",
      to: "worker",
      kind: "attention",
      taskId: "pt-42",
      taskVersion: taskVersionRef("v3"),
      text: "Please resolve the open question.",
      expectedSender: {
        membershipId: "membership_lead",
        sessionFile: "/tmp/lead.jsonl",
      },
    });

    expect(messaging.sendPlainMessage).toHaveBeenCalledWith(
      "dogfood",
      "team-lead",
      "worker",
      expect.stringMatching(new RegExp(`PiTeams attention Alert[\\s\\S]*Task: pt-42 @ ${taskVersionRef("v3")}[\\s\\S]*does not assign`)),
      "attention for Task pt-42",
      undefined,
      { membershipId: "membership_lead", sessionFile: "/tmp/lead.jsonl" },
    );
    expect(appendTeamEvent).toHaveBeenCalledWith("dogfood", expect.objectContaining({
      type: "alert",
      alertId: expect.stringMatching(/^alert_/),
      from: "team-lead",
      to: "worker",
      taskRef: { taskId: "pt-42", version: taskVersionRef("v3") },
      kind: "attention",
      text: "Please resolve the open question.",
    }));
    expect(result).toMatchObject({
      cursor: "7",
      accepted: [{ recipient: "worker", messageId: "message_1" }],
      failures: [],
    });
  });

  it("rejects a raw Task version before delivery", async () => {
    await expect(sendAlert({ teamName: "dogfood", from: "team-lead", to: "worker", kind: "attention", taskId: "pt-42", taskVersion: "raw-version", text: "Review the Task." })).rejects.toThrowError(expect.objectContaining({ name: "upgrade_required" }));
    expect(messaging.sendPlainMessage).not.toHaveBeenCalled();
  });

  it("combines broadcast into one announcement Alert event while preserving per-recipient receipts", async () => {
    vi.mocked(messaging.broadcastMessage).mockResolvedValue({
      accepted: [
        { recipient: "worker-a", messageId: "message_a" },
        { recipient: "worker-b", messageId: "message_b" },
      ],
      failures: [],
    });

    const result = await sendAlert({
      teamName: "dogfood",
      from: "team-lead",
      to: "*",
      kind: "announcement",
      text: "The integration fixture changed.",
    });

    expect(messaging.broadcastMessage).toHaveBeenCalledOnce();
    expect(appendTeamEvent).toHaveBeenCalledWith("dogfood", expect.objectContaining({
      type: "alert",
      to: "*",
      kind: "announcement",
      text: "The integration fixture changed.",
    }));
    expect(result.accepted).toHaveLength(2);
  });

  it("rejects ambiguous Alert shapes before touching delivery or event state", async () => {
    await expect(sendAlert({
      teamName: "dogfood",
      from: "team-lead",
      to: "*",
      kind: "clarification",
      text: "Can everyone answer?",
    })).rejects.toThrow(/Only announcement Alerts/);
    await expect(sendAlert({
      teamName: "dogfood",
      from: "worker",
      to: "*",
      kind: "announcement",
      text: "I should not fan this out.",
    })).rejects.toThrow(/Only team-lead/);
    await expect(sendAlert({
      teamName: "dogfood",
      from: "team-lead",
      to: "worker",
      kind: "attention",
      taskVersion: "v3",
      text: "Review this.",
    })).rejects.toThrow(/taskVersion requires taskId/);

    expect(messaging.sendPlainMessage).not.toHaveBeenCalled();
    expect(messaging.broadcastMessage).not.toHaveBeenCalled();
    expect(appendTeamEvent).not.toHaveBeenCalled();
  });
});
