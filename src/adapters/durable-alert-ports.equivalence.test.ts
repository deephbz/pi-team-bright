import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  appendTeamEvent: vi.fn(),
  readConfig: vi.fn(),
  teamExists: vi.fn(),
  withCurrentConfig: vi.fn(),
}));

vi.mock("../utils/teams", () => ({
  readConfig: calls.readConfig,
  teamExists: calls.teamExists,
  withCurrentConfig: calls.withCurrentConfig,
}));
vi.mock("../utils/team-events", () => ({ appendTeamEvent: calls.appendTeamEvent }));

import { DurableAlertMembership } from "./durable-alert-membership";
import { DurableAlertPublication } from "./durable-alert-publication";

const teamName = "alert-port-equivalence";
const currentConfig = {
  members: [
    { name: "team-lead", isActive: true, membershipId: "lead-current", sessionFile: "/sessions/lead-current.jsonl" },
    { name: "worker-a", isActive: true, membershipId: "worker-a-old", sessionFile: "/sessions/worker-a-old.jsonl" },
    { name: "worker-b", isActive: false, membershipId: "worker-b-old", sessionFile: "/sessions/worker-b-old.jsonl" },
    { name: "worker-a", isActive: true, membershipId: "worker-a-current", sessionFile: "/sessions/worker-a-current.jsonl" },
    { name: "worker-c", isActive: true, membershipId: "worker-c-current", sessionFile: "/sessions/worker-c-current.jsonl" },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  calls.teamExists.mockReturnValue(true);
  calls.readConfig.mockResolvedValue(currentConfig);
  calls.withCurrentConfig.mockImplementation(async (_teamName, action) => await action(currentConfig));
});

describe("durable Alert port equivalence", () => {
  it("keeps the ordered recipient roster outside Alert while leasing exact current identities through append", async () => {
    const membership = new DurableAlertMembership();

    await expect(membership.currentRecipients(teamName, "team-lead")).resolves.toEqual({
      kind: "current",
      recipients: [{ name: "worker-a" }, { name: "worker-a" }, { name: "worker-c" }],
    });

    const appended = vi.fn(async (delivery) => ({ messageId: `message-${delivery.recipientMembershipId}` }));
    await expect(membership.withCurrentDelivery({
      teamName,
      from: "team-lead",
      to: "worker-a",
      expectedSender: { membershipId: "lead-current", sessionFile: "/sessions/lead-current.jsonl" },
    }, appended)).resolves.toEqual({
      kind: "delivered",
      value: { messageId: "message-worker-a-current" },
    });
    expect(appended).toHaveBeenCalledWith({
      recipientMembershipId: "worker-a-current",
      senderMembershipId: "lead-current",
    });
    expect(calls.withCurrentConfig).toHaveBeenCalledWith(teamName, expect.any(Function));
  });

  it.each([
    [false, "team_absent"],
    [true, "recipient_absent"],
    [true, "recipient_unresolved"],
    [true, "sender_stale"],
  ] as const)("returns %s/%s without an inbox append", async (exists, outcome) => {
    const membership = new DurableAlertMembership();
    calls.teamExists.mockReturnValue(exists);
    if (outcome === "recipient_absent") {
      calls.withCurrentConfig.mockImplementation(async (_teamName, action) => await action({ members: [] }));
    } else if (outcome === "recipient_unresolved") {
      calls.withCurrentConfig.mockImplementation(async (_teamName, action) => await action({
        members: [{ name: "worker-a", isActive: true }],
      }));
    } else if (outcome === "sender_stale") {
      calls.withCurrentConfig.mockImplementation(async (_teamName, action) => await action({
        members: [{ name: "worker-a", isActive: true, membershipId: "worker-a-current" }],
      }));
    }
    const appended = vi.fn();

    await expect(membership.withCurrentDelivery({
      teamName,
      from: "team-lead",
      to: "worker-a",
      expectedSender: { membershipId: "lead-current", sessionFile: "/sessions/lead-current.jsonl" },
    }, appended)).resolves.toEqual({ kind: outcome });
    expect(appended).not.toHaveBeenCalled();
  });

  it("fences direct delivery on the exact current Session binding", async () => {
    const membership = new DurableAlertMembership();

    await expect(membership.isCurrentSessionBinding({
      teamName,
      recipient: "worker-a",
      membershipId: "worker-a-current",
      sessionFile: "/sessions/worker-a-current.jsonl",
    })).resolves.toBe(true);
    await expect(membership.isCurrentSessionBinding({
      teamName,
      recipient: "worker-a",
      membershipId: "worker-a-current",
      sessionFile: "/sessions/worker-a-old.jsonl",
    })).resolves.toBe(false);
  });

  it("keeps Team and Coordination imports in durable adapters and injects the one configured sender", () => {
    const root = process.cwd();
    for (const file of ["alerts.ts", "inbox-delivery.ts", "direct-delivery.ts"]) {
      const source = fs.readFileSync(path.join(root, "src/alert-authority", file), "utf8");
      expect(source).not.toMatch(/(?:from|import)\s*["'][^"']*utils\/(?:teams|team-events)["']/);
    }
    expect(fs.readFileSync(path.join(root, "src/adapters/durable-alert-membership.ts"), "utf8"))
      .toMatch(/from\s+["']\.\.\/utils\/teams["']/);
    expect(fs.readFileSync(path.join(root, "src/adapters/durable-alert-publication.ts"), "utf8"))
      .toMatch(/from\s+["']\.\.\/utils\/team-events["']/);

    const extension = fs.readFileSync(path.join(root, "extensions/index.ts"), "utf8");
    expect(extension.match(/const alertMembership = new DurableAlertMembership\(\)/g)).toHaveLength(1);
    expect(extension.match(/const alertPublication = new DurableAlertPublication\(\)/g)).toHaveLength(1);
    expect(extension.match(/const alertSender = createAlertSender\(alertMembership, alertPublication\)/g)).toHaveLength(1);
    expect(extension).toContain("new DurableModelToolTeamPort(workerLaunchBridge, lifecycle, taskAdapterFactory, alertSender, coordinationQueries)");
    expect(extension).toContain("alertSender.sendAlert({ teamName: binding.teamName");

    const sessionAdapter = fs.readFileSync(path.join(root, "extensions/pi-team-session-adapter.ts"), "utf8");
    expect(sessionAdapter).toContain("membership: alertMembership,");
  });

  it("forwards the exact accepted Alert event and its durable cursor", async () => {
    calls.appendTeamEvent.mockResolvedValue({ cursor: "cursor-42" });
    const publication = new DurableAlertPublication();
    const input = {
      teamName,
      alertId: "alert_42",
      from: "team-lead",
      to: "worker-a" as const,
      taskRef: { taskId: "task-42", version: "v_0123456789abcdef" as any },
      kind: "attention" as const,
      text: "Review the exact evidence.",
    };

    await expect(publication.appendAcceptedAlert(input)).resolves.toEqual({ cursor: "cursor-42" });
    expect(calls.appendTeamEvent).toHaveBeenCalledWith(teamName, {
      type: "alert",
      alertId: "alert_42",
      from: "team-lead",
      to: "worker-a",
      taskRef: { taskId: "task-42", version: "v_0123456789abcdef" },
      kind: "attention",
      text: "Review the exact evidence.",
    });
  });
});
