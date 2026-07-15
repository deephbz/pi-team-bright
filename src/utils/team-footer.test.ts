import fs from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as paths from "./paths";
import {
  resolveTeamFooterBinding,
  syncTeamFooter,
  teamFooterFactory,
  type TeamFooterBinding,
} from "./team-footer";
import * as teams from "./teams";

const createdTeams: string[] = [];

function uniqueTeam(suffix: string): string {
  const name = `footer-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(name);
  return name;
}

function model() {
  return {
    id: "gpt-test",
    provider: "test-provider",
    reasoning: true,
    contextWindow: 100_000,
  } as any;
}

function context(sessionFile: string, cwd = "/tmp/footer-project") {
  const setFooter = vi.fn();
  const setStatus = vi.fn();
  return {
    mode: "tui" as const,
    ui: { setFooter, setStatus },
    sessionManager: {
      getSessionFile: vi.fn(() => sessionFile),
      getEntries: vi.fn(() => []),
      getBranch: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: { isUsingOAuth: vi.fn(() => false) },
    getContextUsage: vi.fn(() => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 })),
    setFooter,
    setStatus,
  } as any;
}

function pi() {
  return { getThinkingLevel: vi.fn(() => "high") } as any;
}

function footerData(statuses = new Map<string, string>()) {
  return {
    getGitBranch: vi.fn(() => "feature/footer"),
    getExtensionStatuses: vi.fn(() => statuses),
    getAvailableProviderCount: vi.fn(() => 2),
    onBranchChange: vi.fn(() => vi.fn()),
  } as any;
}

const theme = {
  fg: vi.fn((_color: string, text: string) => text),
} as any;

function plain(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeAll(() => initTheme());

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("Team identity footer projection", () => {
  it("installs a same-line label only from the current exact Session/Membership binding", async () => {
    const teamName = uniqueTeam("active");
    const sessionFile = `/tmp/${teamName}-reviewer.jsonl`;
    await teams.createTeam(teamName, `/tmp/${teamName}-lead.jsonl`, "lead");
    await teams.addMember(teamName, {
      membershipId: teams.newMembershipId(),
      agentId: `reviewer@${teamName}`,
      name: "reviewer",
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile,
      cwd: "/tmp/footer-project",
      subscriptions: [],
    });
    const reviewer = (await teams.readConfig(teamName)).members.find(member => member.name === "reviewer")!;
    const ctx = context(sessionFile);
    const currentModel = model();

    const binding = await syncTeamFooter(pi(), ctx, {
      teamName,
      role: "reviewer",
      membershipId: reviewer.membershipId,
    }, () => currentModel);

    expect(binding).toEqual({
      teamName,
      role: "reviewer",
      membershipId: reviewer.membershipId,
      sessionFile,
    });
    expect(ctx.setStatus).toHaveBeenCalledWith("00-pi-teams", undefined);
    expect(ctx.setStatus).toHaveBeenCalledWith("pi-teams", undefined);
    const factory = ctx.setFooter.mock.calls.at(-1)?.[0];
    expect(factory).toEqual(expect.any(Function));

    const statuses = new Map([["pi-tps", "TPS: 60.6 tok/s"]]);
    const component = factory({ requestRender: vi.fn() } as any, theme, footerData(statuses));
    const lines = component.render(140);
    expect(plain(lines[0])).toContain(`[${teamName} · reviewer] /tmp/footer-project (feature/footer)`);
    expect(lines[1]).toContain("gpt-test");
    expect(lines[2]).toBe("TPS: 60.6 tok/s");
    component.dispose();
  });

  it("shows no label for standalone, fork/unbound, stale-Session, or inactive Membership candidates", async () => {
    const teamName = uniqueTeam("not-current");
    const sessionFile = `/tmp/${teamName}-lead.jsonl`;
    const config = await teams.createTeam(teamName, sessionFile, "lead");
    const lead = config.members[0];

    const standalone = context("/tmp/standalone.jsonl");
    await expect(syncTeamFooter(pi(), standalone, {}, () => model())).resolves.toBeUndefined();
    expect(standalone.setFooter).toHaveBeenLastCalledWith(undefined);

    const fork = context(`/tmp/${teamName}-fork.jsonl`);
    await expect(syncTeamFooter(pi(), fork, {
      teamName,
      role: "team-lead",
      membershipId: lead.membershipId,
    }, () => model())).resolves.toBeUndefined();
    expect(fork.setFooter).toHaveBeenLastCalledWith(undefined);

    await teams.deactivateMembership(teamName, lead.membershipId!, "replaced");
    const inactive = context(sessionFile);
    await expect(resolveTeamFooterBinding(inactive, {
      teamName,
      role: "team-lead",
      membershipId: lead.membershipId,
    })).resolves.toBeUndefined();
  });

  it("truncates the prefixed cwd line to narrow terminal width without changing status lines", () => {
    const binding: TeamFooterBinding = {
      teamName: "very-long-team-name",
      role: "reviewer",
      membershipId: "membership-current",
      sessionFile: "/tmp/current.jsonl",
    };
    const ctx = context("/tmp/current.jsonl", "/tmp/a-very-long-project-directory");
    const factory = teamFooterFactory(pi(), ctx, binding, () => model());
    const statuses = new Map([["pi-tps", "TPS: 60.6 tok/s"]]);
    const component = factory({ requestRender: vi.fn() } as any, theme, footerData(statuses));

    const lines = component.render(24);

    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(24);
    expect(lines[0]).toContain("...");
    expect(lines.at(-1)).toBe("TPS: 60.6 tok/s");
    component.dispose?.();
  });
});
