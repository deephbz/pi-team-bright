import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurablePiSessionTeamQuery } from "./durable-pi-session-team-query";
import * as paths from "../utils/paths";
import * as teams from "../utils/teams";

const created: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of created.splice(0)) fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
});

describe("DurablePiSessionTeamQuery", () => {
  it("reads exact Session, placement, policy, profile, and nudge evidence without exposing Team records", async () => {
    const teamName = `pi-session-query-${process.pid}-${Date.now()}`;
    created.push(teamName);
    const leaderSessionFile = `/tmp/${teamName}-lead.jsonl`;
    const workerSessionFile = `/tmp/${teamName}-worker.jsonl`;
    await teams.createTeam(teamName, leaderSessionFile, "lead", "", undefined, undefined, `/tmp/${teamName}-beads`, "authority", {
      schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: teamName, projectId: teamName,
    });
    await teams.addMember(teamName, {
      agentId: `worker@${teamName}`, name: "worker", agentType: "teammate", joinedAt: Date.now(),
      tmuxPaneId: "", sessionFile: workerSessionFile, cwd: process.cwd(), subscriptions: [],
      prompt: "Keep evidence.", model: "test/model", thinking: "high",
    });
    const config = await teams.readConfig(teamName);
    const leaderMembershipId = config.members.find((member) => member.name === "team-lead")!.membershipId!;
    const query = new DurablePiSessionTeamQuery();

    const workerMembershipId = config.members.find((member) => member.name === "worker")!.membershipId;
    expect(query.findTeammateBySessionFile(workerSessionFile)).toEqual({
      teamName,
      member: { name: "worker", membershipId: workerMembershipId },
    });
    await expect(query.currentSessionBinding(teamName, "worker", workerSessionFile)).resolves.toEqual({ membershipId: workerMembershipId });
    vi.spyOn(teams, "resolveCurrentTeammateSessionBinding").mockResolvedValue({
      status: "bound", teamName,
      member: { name: "worker", membershipId: workerMembershipId, sessionFile: workerSessionFile, prompt: "Keep evidence." },
    } as any);
    await expect(query.resolveCurrentTeammateSessionBinding(workerSessionFile)).resolves.toEqual({
      status: "bound", teamName,
      member: { name: "worker", membershipId: workerMembershipId, sessionFile: workerSessionFile },
    });
    await expect(query.terminalPlacement(teamName)).resolves.toEqual({ name: teamName, terminalBackend: undefined });
    await expect(query.workerProfile(teamName, "worker")).resolves.toEqual({ prompt: "Keep evidence.", model: "test/model", thinking: "high" });
    await expect(query.activeMembershipId(teamName, "worker")).resolves.toEqual(expect.any(String));
    await expect(query.matchesSyncNudgeCandidate({
      teamName, teamEpochId: config.epochId!, leaderSessionFile, leaderMembershipId,
    })).resolves.toBe(true);
    await expect(query.matchesSyncNudgeCandidate({
      teamName, teamEpochId: "wrong-epoch", leaderSessionFile, leaderMembershipId,
    })).resolves.toBe(false);
  });

  it("fences query DTOs from full Member records", () => {
    const contract = fs.readFileSync("src/team-authority/pi-session-team-query.ts", "utf8");
    const adapter = fs.readFileSync("src/adapters/durable-pi-session-team-query.ts", "utf8");
    expect(contract).not.toContain('import type { Member');
    expect(contract).not.toContain("Promise<Member>");
    expect(contract).not.toContain("member: Member");
    expect(adapter).not.toContain('import type { Member');
  });
});
