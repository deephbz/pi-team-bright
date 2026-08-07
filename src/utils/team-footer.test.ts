import fs from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as paths from "./paths";
import {
  resolveTeamFooterBinding,
  syncTeamFooter,
  teamFooterFactory,
  latestMessageClock,
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

function context(sessionFile: string, cwd = "/tmp/footer-project", entries: any[] = []) {
  const setFooter = vi.fn();
  const setStatus = vi.fn();
  return {
    mode: "tui" as const,
    ui: { setFooter, setStatus },
    sessionManager: {
      getSessionFile: vi.fn(() => sessionFile),
      getEntries: vi.fn(() => entries),
      getBranch: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => false),
      getProvider: vi.fn(() => undefined),
    },
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
    expect(theme.fg).toHaveBeenCalledWith("dim", "reviewer");
    expect(lines[1]).toContain("gpt-test");
    expect(lines[2]).toBe("TPS: 60.6 tok/s");
    component.dispose?.();
  });

  it("renders a Pi 0.84-shaped subscription runtime footer", () => {
    const binding: TeamFooterBinding = {
      teamName: "subscription-team",
      role: "team-lead",
      membershipId: "membership-subscription",
      sessionFile: "/tmp/subscription.jsonl",
    };
    const ctx = context(binding.sessionFile);
    ctx.modelRegistry.isUsingOAuth.mockReturnValue(true);
    ctx.modelRegistry.getProvider.mockReturnValue({ auth: { oauth: { isSubscription: true } } });
    const factory = teamFooterFactory(pi(), ctx, binding, () => model());
    const component = factory({ requestRender: vi.fn() } as any, theme, footerData());

    expect(() => component.render(140)).not.toThrow();
    expect(plain(component.render(140)[0])).toContain("[subscription-team · team-lead]");
    expect(ctx.modelRegistry.isUsingOAuth).toHaveBeenCalled();
    component.dispose?.();
  });

  it("keeps the lead role accent and shows the local time of the latest message", () => {
    const latest = new Date(2026, 6, 17, 9, 4, 0).toISOString();
    const older = new Date(2026, 6, 17, 8, 3, 0).toISOString();
    const binding: TeamFooterBinding = {
      teamName: "release-team",
      role: "team-lead",
      membershipId: "membership-lead",
      sessionFile: "/tmp/lead.jsonl",
    };
    const ctx = context("/tmp/lead.jsonl", "/tmp/footer-project", [
      { type: "message", timestamp: older, message: { role: "user", content: "older", timestamp: older } },
      { type: "model_change", timestamp: new Date(2026, 6, 17, 10, 0, 0).toISOString() },
      { type: "message", timestamp: latest, message: { role: "user", content: "latest", timestamp: latest } },
    ]);
    const factory = teamFooterFactory(pi(), ctx, binding, () => model());
    const component = factory({ requestRender: vi.fn() } as any, theme, footerData());

    const lines = component.render(140);

    expect(plain(lines[0])).toContain("[release-team · team-lead · 09:04]");
    expect(theme.fg).toHaveBeenCalledWith("accent", "team-lead");
    expect(theme.fg).not.toHaveBeenCalledWith("dim", "team-lead");
    component.dispose?.();
  });

  it("derives message time from message entries only", () => {
    const first = new Date(2026, 6, 17, 7, 8, 0).toISOString();
    const last = new Date(2026, 6, 17, 11, 12, 0).toISOString();
    expect(latestMessageClock([
      { type: "message", timestamp: first },
      { type: "label", timestamp: new Date(2026, 6, 17, 12, 0, 0).toISOString() },
      { type: "message", timestamp: "invalid" },
      { type: "custom_message", timestamp: last },
    ])).toBe("11:12");
    expect(latestMessageClock([])).toBeUndefined();
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
