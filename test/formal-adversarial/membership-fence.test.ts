import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableTaskChangeDeliveryMembership } from "../../src/adapters/durable-task-change-delivery-membership";
import type { TeamConfig } from "../../src/team-authority/contracts";
import { configPath, teamDir } from "../../src/utils/paths";
import { writeConfigAtomic } from "../../src/utils/teams";

const teams: string[] = [];
afterEach(() => {
  for (const team of teams.splice(0)) fs.rmSync(teamDir(team), { force: true, recursive: true });
});

describe("exact Membership and Session delivery fence", () => {
  it("refuses an old recipient that was current before replacement", async () => {
    const teamName = `formal-membership-${process.pid}-${Date.now()}`;
    teams.push(teamName);
    const oldSession = path.join(teamDir(teamName), "old.jsonl");
    const newSession = path.join(teamDir(teamName), "new.jsonl");
    const config: TeamConfig = {
      name: teamName, description: "Exact delivery Membership fixture.", createdAt: 0,
      leadAgentId: "lead", leadSessionId: "lead-session", epochId: "epoch",
      logicalWorkers: [{ name: "worker", scope: "Execute work." }],
      members: [{
        membershipId: "m-old", agentId: "old-agent", name: "worker", agentType: "teammate",
        joinedAt: 0, sessionFile: oldSession, cwd: process.cwd(), subscriptions: [],
      }],
    };
    fs.mkdirSync(teamDir(teamName), { recursive: true });
    writeConfigAtomic(configPath(teamName), config);
    const adapter = new DurableTaskChangeDeliveryMembership();
    expect(await adapter.currentRecipient({ teamName, recipient: "worker", sessionFile: oldSession }))
      .toEqual({ membershipId: "m-old" });

    config.members[0].isActive = false;
    config.members.push({
      membershipId: "m-new", agentId: "new-agent", name: "worker", agentType: "teammate",
      joinedAt: 1, sessionFile: newSession, cwd: process.cwd(), subscriptions: [],
    });
    writeConfigAtomic(configPath(teamName), config);
    const staleEffect = vi.fn(async () => "stale write");
    await expect(adapter.withCurrentRecipient({
      teamName, recipient: "worker", sessionFile: oldSession, membershipId: "m-old",
    }, staleEffect)).rejects.toThrow(/not the current binding/);
    expect(staleEffect).not.toHaveBeenCalled();
    await expect(adapter.withCurrentRecipient({
      teamName, recipient: "worker", sessionFile: newSession, membershipId: "m-new",
    }, async () => "new write")).resolves.toBe("new write");
  });
});
