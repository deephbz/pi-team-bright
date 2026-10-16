import fs from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as paths from "./paths";
import {
  resolveTeamFooterBinding,
  syncTeamFooter,
  teamFooterFactory,
  clearTeamFooter,
  initializeTeamFooter,
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
      getSessionId: vi.fn(() => `session-${sessionFile}`),
      getLeafId: vi.fn(() => null),
      getEntryCount: vi.fn(() => entries.length),
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
  const handlers = new Map<string, Array<(value: unknown) => void>>();
  return {
    getThinkingLevel: vi.fn(() => "high"),
    setSessionName: vi.fn(),
    events: {
      on: (channel: string, handler: (value: unknown) => void) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
        return () => {};
      },
      emit: vi.fn((channel: string, value: unknown) => {
        for (const handler of handlers.get(channel) ?? []) handler(value);
      }),
    },
  } as any;
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
  it("publishes exact identity, replays it, and yields the footer to a composer", async () => {
    const api = pi();
    const ctx = context("/tmp/hud.jsonl");
    const candidate = { teamName: "20261010-review", role: "reviewer", membershipId: "current" };
    vi.spyOn(teams, "assertCurrentSessionBinding").mockResolvedValue({ membershipId: "current" } as any);
    initializeTeamFooter(api);
    await syncTeamFooter(api, ctx, candidate, () => model());
    expect(api.setSessionName).toHaveBeenCalledWith("20261010-review/reviewer");
    const slot = api.events.emit.mock.calls.at(-1)[1];
    expect(slot).toMatchObject({ v: 1, key: "team.member", producer: "pi-team-bright", value: { kind: "identity", team: candidate.teamName, role: "reviewer", membershipId: "current" } });
    api.events.emit("hc.hud.composer", { v: 1, present: true, surface: "tui-footer" });
    expect(ctx.setFooter).toHaveBeenLastCalledWith(undefined);
    await new Promise(resolve => setImmediate(resolve));
    expect(api.events.emit.mock.calls.at(-1)[0]).toBe("hc.hud.slot");
    expect(api.events.emit.mock.calls.at(-1)[1].value).toEqual(slot.value);
    ctx.setFooter.mockClear();
    await syncTeamFooter(api, ctx, candidate, () => model());
    expect(ctx.setFooter).not.toHaveBeenCalled();
    api.events.emit("hc.hud.composer", { v: 1, present: false, surface: "tui-footer" });
    expect(ctx.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
    clearTeamFooter(ctx, api);
    expect(api.events.emit.mock.calls.at(-1)[1].value).toBeNull();
    expect(ctx.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  it("rechecks exact membership on replay and retracts a replaced binding", async () => {
    const api = pi();
    const ctx = context("/tmp/hud-replay.jsonl");
    const read = vi.spyOn(teams, "assertCurrentSessionBinding").mockResolvedValue({ membershipId: "current" } as any);
    await syncTeamFooter(api, ctx, { teamName: "team", role: "team-lead", membershipId: "current" }, () => model());
    expect(api.setSessionName).not.toHaveBeenCalled();
    read.mockResolvedValue({ membershipId: "replacement" } as any);
    api.events.emit("hc.hud.composer", { v: 1, present: true, surface: "tui-footer" });
    await new Promise(resolve => setImmediate(resolve));
    expect(api.events.emit.mock.calls.at(-1)[1].value).toBeNull();
  });

  it("enforces the Worker name only when different, without a Session-name hook loop", async () => {
    const api = pi();
    const ctx = context("/tmp/hud-worker-name.jsonl");
    ctx.sessionManager.getSessionName.mockReturnValue("Human or Rarebit title");
    const candidate = { teamName: "team", role: "worker", membershipId: "current" };
    vi.spyOn(teams, "assertCurrentSessionBinding").mockResolvedValue({ membershipId: "current" } as any);
    api.setSessionName.mockImplementation((name: string) => ctx.sessionManager.getSessionName.mockReturnValue(name));
    await syncTeamFooter(api, ctx, candidate, () => model());
    expect(api.setSessionName).toHaveBeenCalledExactlyOnceWith("team/worker");
    await syncTeamFooter(api, ctx, candidate, () => model());
    expect(api.setSessionName).toHaveBeenCalledTimes(1);
    ctx.sessionManager.getSessionName.mockReturnValue("Another title");
    await syncTeamFooter(api, ctx, candidate, () => model());
    expect(api.setSessionName).toHaveBeenCalledTimes(2);
    expect(api.setSessionName).toHaveBeenLastCalledWith("team/worker");
  });

  it.each([undefined, "Human or Rarebit title", "Old PTB leader title"])("leaves a leader name unchanged: %s", async name => {
    const api = pi();
    const ctx = context("/tmp/hud-leader-name.jsonl");
    ctx.sessionManager.getSessionName.mockReturnValue(name);
    vi.spyOn(teams, "assertCurrentSessionBinding").mockResolvedValue({ membershipId: "current" } as any);
    await syncTeamFooter(api, ctx, { teamName: "team", role: "team-lead", membershipId: "current" }, () => model());
    expect(api.setSessionName).not.toHaveBeenCalled();
    expect(ctx.sessionManager.getSessionName()).toBe(name);
  });

  it("retains a user Session name and publishes in non-TUI mode without wrapping", async () => {
    const api = pi();
    const ctx = context("/tmp/hud-rpc.jsonl");
    ctx.mode = "rpc";
    ctx.sessionManager.getSessionName.mockReturnValue("User label");
    vi.spyOn(teams, "assertCurrentSessionBinding").mockResolvedValue({ membershipId: "current" } as any);
    await syncTeamFooter(api, ctx, { teamName: "team", role: "team-lead", membershipId: "current" }, () => model());
    expect(api.setSessionName).not.toHaveBeenCalled();
    expect(api.events.emit.mock.calls.at(-1)[1].value.role).toBe("team-lead");
    expect(ctx.setFooter.mock.calls.every(([factory]: any[]) => factory === undefined)).toBe(true);
  });

  it("keeps identity publication when a presentation label fails", async () => {
    const api = pi();
    const ctx = context("/tmp/hud-label-failure.jsonl");
    api.setSessionName.mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(teams, "assertCurrentSessionBinding").mockResolvedValue({ membershipId: "current" } as any);
    await syncTeamFooter(api, ctx, { teamName: "team", role: "worker", membershipId: "current" }, () => model());
    expect(api.events.emit.mock.calls.at(-1)[1].value.team).toBe("team");
  });

  it("honors composer-first presence, surface scoping, and footer ownership on clear", async () => {
    const api = pi();
    const ctx = context("/tmp/hud-first.jsonl");
    initializeTeamFooter(api);
    api.events.emit("hc.hud.composer", { v: 1, present: true, surface: "tui-footer" });
    vi.spyOn(teams, "assertCurrentSessionBinding").mockResolvedValue({ membershipId: "current" } as any);
    await syncTeamFooter(api, ctx, { teamName: "team", role: "team-lead", membershipId: "current" }, () => model());
    clearTeamFooter(ctx, api);
    expect(ctx.setFooter).not.toHaveBeenCalled();
    api.events.emit("hc.hud.composer", { v: 1, present: false, surface: "gui" });
    expect(ctx.setFooter).not.toHaveBeenCalled();
    expect(api.events.emit.mock.calls.find(([channel, slot]: any[]) => channel === "hc.hud.slot" && slot.value)?.[1]).not.toHaveProperty("staleAfterMs");
  });

  it("retracts stale bindings and fences an in-flight resolve after clear", async () => {
    const api = pi();
    const ctx = context("/tmp/hud-stale.jsonl");
    let finish!: (member: any) => void;
    vi.spyOn(teams, "assertCurrentSessionBinding").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = syncTeamFooter(api, ctx, { teamName: "team", role: "team-lead", membershipId: "current" }, () => model());
    clearTeamFooter(ctx, api);
    finish({ membershipId: "current" });
    await expect(pending).resolves.toBeUndefined();
    expect(api.events.emit.mock.calls.at(-1)[1].value).toBeNull();
    expect(api.setSessionName).not.toHaveBeenCalled();
  });

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
    expect(plain(lines[0])).toContain("[reviewer] /tmp/footer-project (feature/footer)");
    expect(plain(lines[0])).not.toContain(teamName);
    expect(theme.fg).toHaveBeenCalledWith("dim", "[reviewer] ");
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
    expect(plain(component.render(140)[0])).toContain("[team-lead]");
    expect(ctx.modelRegistry.isUsingOAuth).toHaveBeenCalled();
    component.dispose?.();
  });

  it("keeps the lead role accent and omits the Team and message clock", () => {
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

    expect(plain(lines[0])).toContain("[team-lead] ");
    expect(plain(lines[0])).not.toContain("release-team");
    expect(plain(lines[0])).not.toContain("09:04");
    expect(theme.fg).toHaveBeenCalledWith("accent", "[team-lead] ");
    component.dispose?.();
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

    await teams.deactivateMembership(teamName, lead.membershipId!, "replaced", { authority: "process_stopped", carrier: "two_stage" });
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
