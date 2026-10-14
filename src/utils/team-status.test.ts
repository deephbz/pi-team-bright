import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import type { TeamConfig } from "../team-authority/contracts";
import { deriveCarrierView, type CarrierView } from "../carrier-observation";
import * as paths from "./paths";
import {
  diagnoseTeam,
  formatTeamStatus,
  formatCarrierStatus,
  getPiTeamsArgumentCompletions,
  parsePiTeamsCommand,
} from "./team-status";

type RegisteredCommand = {
  description: string;
  getArgumentCompletions(prefix: string): Array<{ value: string; description?: string }> | null;
  handler(args: string, ctx: any): Promise<void>;
};

const createdTeams: string[] = [];

function fixtureConfig(teamName: string, sessionFile = `/tmp/${teamName}-lead.jsonl`): TeamConfig {
  return {
    name: teamName,
    description: "status fixture",
    createdAt: Date.parse("2026-07-26T00:00:00.000Z"),
    leadAgentId: "lead-agent",
    leadSessionId: sessionFile,
    terminalBackend: "tmux",
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
  for (const teamName of createdTeams.splice(0)) fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
});

it("bounds and sanitizes unknown status facts while keeping selected detail", () => {
  const view = { worker: "worker", process: "unknown", launch: "unknown", terminal: "present", activity: "unknown",
    evidence: [{ source: "process_generation", fact: "generation_helper_missing\n\u001b[31mred\u001b[0m" },
      { source: "launch", fact: `timeout: ${"x".repeat(200)}` }, { source: "other", fact: "unrelated secret" }] } as CarrierView;
  const result = formatCarrierStatus(view);
  expect(result.line).toContain("process unknown (generation_helper_missing red)");
  expect(result.line).not.toMatch(/[\n\u001b]/);
  expect(result.line).not.toContain("unrelated secret");
  expect(result.line).toContain(`launch unknown (timeout: ${"x".repeat(110)}…)`);
  expect(result.facts.launch).toBe(view.evidence[1].fact);
});

it.each(["absent", "found"] as const)("keeps both human exits before status truncation for probe %s", kind => {
  const member = { name: "worker", membershipId: "m", sessionFile: "/session" } as TeamConfig["members"][number];
  const view = deriveCarrierView(member, { teamName: "team", agentName: "worker", membershipId: "m", pid: 42, startedAt: 1 }, 100,
    kind === "absent" ? { kind } : { kind, generation: { pid: 42, osBirthToken: "birth", bootId: "boot" } });
  const result = formatCarrierStatus(view);
  for (const text of ["legacy_unverified", "ask_human", kind === "absent" ? "Restart this Worker's Pi in its pane, or stop the Worker." : "Reload this Worker's Pi, or adopt it in /ptb status."]) expect(result.line).toContain(text);
});

describe("/pi-team-bright command grammar", () => {
  it("defaults to status and rejects extra arguments", () => {
    expect(parsePiTeamsCommand("")).toEqual({ ok: true, subcommand: "status" });
    expect(parsePiTeamsCommand("status")).toEqual({ ok: true, subcommand: "status" });
    expect(parsePiTeamsCommand("help")).toEqual({ ok: true, subcommand: "help" });
    expect(parsePiTeamsCommand("status other")).toMatchObject({ ok: false });
  });
  it("describes bounded status/help completions", () => {
    expect(getPiTeamsArgumentCompletions("st")).toEqual([expect.objectContaining({ value: "status", description: expect.stringMatching(/Diagnose/) })]);
    expect(getPiTeamsArgumentCompletions("status ")).toBeNull();
  });
});

describe("graph Task authority status", () => {
  it("reports the graph authority path and caller-visible graph operations", async () => {
    const teamName = `status-${process.pid}-graph`;
    writeFixture(fixtureConfig(teamName));
    const report = await diagnoseTeam(teamName, {
      role: "team-lead", sessionBinding: "current",
      now: () => new Date("2026-07-26T01:00:00.000Z"),
      verifyGraphAuthority: async name => ({ team: name, tasks: [] }),
    });
    expect(report).toMatchObject({
      schema: "pi-teams-status/1",
      team: { name: teamName, lifecycle: "active", currentMembers: ["team-lead"] },
      storage: { teamDirectory: paths.teamDir(teamName), graphPath: paths.graphTaskAuthorityPath(teamName) },
      taskAuthority: { backend: "graph", health: "verified" },
      externalAccess: { inspectTasks: "Use task_read or /ptb tasks.", editTasks: "Use task_graph_apply and task_update." },
    });
    const rendered = formatTeamStatus(report);
    expect(rendered).toContain(`Task graph: ${paths.graphTaskAuthorityPath(teamName)}`);
    expect(rendered).toContain("Task authority: graph · verified");
    expect(rendered).not.toMatch(/Beads|Dolt|bd --directory/i);
  });

  it("reports a missing graph as degraded instead of presenting an empty Task list", async () => {
    const teamName = `status-${process.pid}-missing-graph`;
    writeFixture(fixtureConfig(teamName));
    const report = await diagnoseTeam(teamName, {
      role: "team-lead", sessionBinding: "stale",
      verifyGraphAuthority: async () => { throw new Error("graph snapshot is unavailable"); },
    });
    expect(report.taskAuthority).toMatchObject({ backend: "graph", health: "degraded", detail: "graph snapshot is unavailable" });
  });
});

describe("Pi extension command integration", () => {
  it("registers status and renders a read-only graph authority diagnosis", async () => {
    const teamName = `status-${process.pid}-command`;
    const sessionFile = `/tmp/${teamName}-lead.jsonl`;
    writeFixture(fixtureConfig(teamName, sessionFile));
    vi.stubEnv("PI_TEAM_NAME", teamName);
    let command: RegisteredCommand | undefined;
    const appendEntry = vi.fn();
    piTeams({ appendEntry, registerTool() {}, registerCommand(name: string, definition: RegisteredCommand) {
      if (name === "pi-team-bright") command = definition;
    }, on() {}, sendUserMessage() {} } as never);
    expect(command?.description).toMatch(/Legacy alias for \/ptb status or \/ptb help/);
    const notify = vi.fn();
    await command!.handler("status", { hasUI: true, sessionManager: { getSessionFile: () => sessionFile }, ui: { notify } });
    expect(appendEntry).toHaveBeenCalledWith("ptb.status", { lines: [expect.stringContaining(`Pi Team Bright · ${teamName}`)] });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain(`Pi Team Bright · ${teamName} · active`);
    expect(notify.mock.calls[0][0]).toContain(`Task graph: ${paths.graphTaskAuthorityPath(teamName)}`);
    expect(notify.mock.calls[0][1]).toBe("warning");
  });
});
