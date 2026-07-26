import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import type { TeamConfig } from "./models";
import * as paths from "./paths";
import {
  diagnoseTeam,
  formatTeamStatus,
  getPiTeamsArgumentCompletions,
  parsePiTeamsCommand,
} from "./team-status";

type RegisteredCommand = {
  description: string;
  getArgumentCompletions(prefix: string): Array<{ value: string; description?: string }> | null;
  handler(args: string, ctx: any): Promise<void>;
};

const createdTeams: string[] = [];

function fixtureConfig(teamName: string, workspace: string, sessionFile = `/tmp/${teamName}-lead.jsonl`): TeamConfig {
  return {
    name: teamName,
    description: "status fixture",
    createdAt: Date.parse("2026-07-26T00:00:00.000Z"),
    leadAgentId: "lead-agent",
    leadSessionId: sessionFile,
    terminalBackend: "tmux",
    taskBackend: "beads",
    taskWorkspace: workspace,
    taskAuthorityId: `task_authority_${teamName}`,
    taskAuthorityFingerprint: {
      schema: "pi-teams-beads-authority/1",
      backend: "dolt",
      database: "dolt",
      doltDatabase: `db_${teamName}`,
      projectId: `project-${teamName}`,
    },
    members: [{
      membershipId: `membership-${teamName}`,
      agentId: "lead-agent",
      name: "team-lead",
      agentType: "lead",
      joinedAt: Date.parse("2026-07-26T00:00:00.000Z"),
      sessionFile,
      cwd: "/tmp",
      subscriptions: [],
      isActive: true,
    }],
  };
}

function writeFixture(config: TeamConfig): void {
  createdTeams.push(config.name);
  fs.mkdirSync(paths.teamDir(config.name), { recursive: true });
  fs.writeFileSync(paths.configPath(config.name), JSON.stringify(config));
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
  }
});

describe("/pi-team-bright command grammar", () => {
  it("defaults to status and rejects extra arguments", () => {
    expect(parsePiTeamsCommand("")).toEqual({ ok: true, subcommand: "status" });
    expect(parsePiTeamsCommand("status")).toEqual({ ok: true, subcommand: "status" });
    expect(parsePiTeamsCommand("help")).toEqual({ ok: true, subcommand: "help" });
    expect(parsePiTeamsCommand("status other")).toMatchObject({ ok: false });
  });

  it("describes bounded status/help completions", () => {
    expect(getPiTeamsArgumentCompletions("st")).toEqual([
      expect.objectContaining({ value: "status", description: expect.stringMatching(/Diagnose/) }),
    ]);
    expect(getPiTeamsArgumentCompletions("status ")).toBeNull();
  });
});

describe("Team status diagnosis", () => {
  it("projects TeamConfig, Beads DB identity, workspace, and external access", async () => {
    const teamName = `status-${process.pid}-projection`;
    const workspace = path.join(paths.teamDir(teamName), "beads-authority");
    const config = fixtureConfig(teamName, workspace);
    writeFixture(config);

    const report = await diagnoseTeam(teamName, {
      role: "team-lead",
      sessionBinding: "current",
      now: () => new Date("2026-07-26T01:00:00.000Z"),
      verifyBeadsAuthority: async () => config.taskAuthorityFingerprint!,
    });

    expect(report).toMatchObject({
      schema: "pi-teams-status/1",
      team: { name: teamName, lifecycle: "active", currentMembers: ["team-lead"] },
      session: { role: "team-lead", binding: "current" },
      storage: { teamDirectory: paths.teamDir(teamName), taskWorkspace: workspace },
      taskAuthority: { backend: "beads", health: "verified", database: `db_${teamName}` },
    });
    const rendered = formatTeamStatus(report);
    expect(rendered).toContain(`Team workspace: ${paths.teamDir(teamName)}`);
    expect(rendered).toContain(`Beads workspace: ${workspace}`);
    expect(rendered).toContain(`Beads database: db_${teamName}`);
    expect(rendered).toContain("Worker memberships: none");
    expect(rendered).toContain(`bd --directory '${workspace}' list --all`);
    expect(rendered).toContain("Beads writes there are authoritative");
  });

  it("keeps configured identity visible when live authority verification degrades", async () => {
    const teamName = `status-${process.pid}-degraded`;
    const config = fixtureConfig(teamName, path.join(paths.teamDir(teamName), "missing"));
    writeFixture(config);
    const report = await diagnoseTeam(teamName, {
      role: "team-lead",
      sessionBinding: "stale",
      verifyBeadsAuthority: async () => { throw new Error("bd where timed out"); },
    });
    expect(report.taskAuthority).toMatchObject({
      health: "degraded",
      database: `db_${teamName}`,
      detail: "bd where timed out",
    });
  });
});

describe("Pi extension command integration", () => {
  it("registers /pi-team-bright status and renders a read-only degraded diagnosis", async () => {
    const teamName = `status-${process.pid}-command`;
    const sessionFile = `/tmp/${teamName}-lead.jsonl`;
    writeFixture(fixtureConfig(teamName, path.join(paths.teamDir(teamName), "missing"), sessionFile));
    vi.stubEnv("PI_TEAM_NAME", teamName);

    let command: RegisteredCommand | undefined;
    piTeams({
      registerTool() {},
      registerCommand(name: string, definition: RegisteredCommand) {
        if (name === "pi-team-bright") command = definition;
      },
      on() {},
      sendUserMessage() {},
    } as never);
    expect(command?.description).toMatch(/status\/help/);

    const notify = vi.fn();
    await command!.handler("status", {
      hasUI: true,
      sessionManager: { getSessionFile: () => sessionFile },
      ui: { notify },
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain(`Pi Team Bright · ${teamName} · active`);
    expect(notify.mock.calls[0][0]).toContain(`Team workspace: ${paths.teamDir(teamName)}`);
    expect(notify.mock.calls[0][0]).toContain(`Beads database: db_${teamName}`);
    expect(notify.mock.calls[0][1]).toBe("warning");
  });

  it("has no pi-teams alias and reads no Team when unbound", async () => {
    const commands = new Map<string, RegisteredCommand>();
    piTeams({
      registerTool() {},
      registerCommand(name: string, definition: RegisteredCommand) { commands.set(name, definition); },
      on() {},
      sendUserMessage() {},
    } as never);
    expect(commands.has("pi-teams")).toBe(false);
    const notify = vi.fn();
    await commands.get("pi-team-bright")!.handler("", { hasUI: true, ui: { notify } });
    expect(notify.mock.calls[0][0]).toMatch(/No current Team is bound/);
    expect(notify.mock.calls[0][0]).not.toMatch(/Task|Worker|runtime progress/i);
  });
});
