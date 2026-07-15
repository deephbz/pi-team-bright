import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import type { TerminalAdapter } from "./terminal-adapter";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import * as messaging from "./messaging";
import type { Member } from "./models";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";

type RegisteredTool = {
  name: string;
  description: string;
  execute: (toolCallId: string, params: any, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
};

const createdTeams: string[] = [];
const temporaryRoots: string[] = [];

function uniqueTeam(suffix: string): string {
  const team = `ergonomic-contract-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(team);
  return team;
}

function temporaryRoot(suffix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-teams-ergonomic-${suffix}-`));
  temporaryRoots.push(root);
  return root;
}

function context(sessionFile: string, cwd = process.cwd()) {
  return {
    cwd,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: { setStatus() {}, notify() {} },
  };
}

function member(name: string, sessionFile: string, extra: Partial<Member> = {}): Member {
  return {
    membershipId: teams.newMembershipId(),
    agentId: `${name}@ergonomic-contract`,
    name,
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
    ...extra,
  };
}

function registerTools(): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  piTeams({
    registerTool(tool: RegisteredTool) { registered.set(tool.name, tool); },
    on() {},
    sendUserMessage() {},
  } as never);
  return registered;
}

function terminal(): TerminalAdapter {
  return {
    name: "ergonomic-contract-terminal",
    detect: () => true,
    spawn: (options: { name: string }) => `pane-${options.name}`,
    kill() {},
    isAlive: () => false,
    setTitle() {},
    supportsWindows: () => false,
    spawnWindow: () => "window-unused",
    setWindowTitle() {},
    killWindow() {},
    isWindowAlive: () => false,
  };
}

function expectDurableReceipt(receipt: any, operation: string, resourceKind: string) {
  expect(receipt).toMatchObject({
    accepted: true,
    operation,
    resource: { kind: resourceKind, id: expect.any(String) },
    postState: expect.any(Object),
    warnings: expect.any(Array),
  });
  // A mutation receipt may say that a runtime observation is absent, but it
  // must never turn launch/acceptance into an unearned readiness claim.
  expect(JSON.stringify(receipt)).not.toMatch(/agentLoopReady|successfulTurnObserved|deliveryReady/i);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAdapterCache();
  for (const team of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(team), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(team), { recursive: true, force: true });
  }
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ergonomic agent-facing Team contracts", () => {
  it("puts durable Team, lead Membership, and Task-authority identity in team_create content", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const team = uniqueTeam("create-receipt");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const tools = registerTools();

    const result = await tools.get("team_create")!.execute(
      "create",
      { team_name: team },
      undefined,
      undefined,
      context(leadSession),
    );

    expectDurableReceipt(result.details.receipt, "team_create", "team");
    expect(result.details.receipt.postState).toMatchObject({
      teamName: team,
      leadMembershipId: expect.any(String),
      taskAuthorityId: expect.any(String),
      membershipState: "current",
    });
    expect(result.content[0].text).toContain(team);
    expect(result.content[0].text).toContain(result.details.receipt.postState.leadMembershipId);
    expect(result.content[0].text).toContain(result.details.receipt.postState.taskAuthorityId);
    expect(result.content[0].text).not.toMatch(/ready|runtime/i);
  }, 30_000);

  it("returns a nonblocking spawn receipt with only committed launch facts", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    setAdapter(terminal());
    const team = uniqueTeam("spawn");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    await teams.createTeam(team, leadSession, "lead");
    const tools = registerTools();

    const result = await tools.get("spawn_teammate")!.execute("spawn", {
      team_name: team,
      name: "worker",
      prompt: "Inspect a long diff.",
      cwd: process.cwd(),
    }, undefined, undefined, context(leadSession));

    expect(result.details).toMatchObject({
      membership: {
        persisted: true,
        current: true,
        teamName: team,
        agentName: "worker",
      },
      terminalLaunch: {
        launched: true,
        adapter: "ergonomic-contract-terminal",
        kind: "pane",
        targetId: "pane-worker",
      },
      runtimeObservation: { checked: false, state: "not_observed" },
      initialMessage: { accepted: true, presentationObserved: false },
    });
    expect(result.details.membership.membershipId).toEqual(expect.any(String));
    expect(result.details.initialMessage.messageId).toEqual(expect.any(String));
    expect(JSON.stringify(result.details)).not.toMatch(/agentLoopReady|successfulTurnObserved|ready/i);
    expect(result.content[0].text).toMatch(/haven't been observed yet/i);
    expectDurableReceipt(result.details.receipt, "spawn_teammate", "membership");
    expect(result.details.receipt.postState).toMatchObject({
      membershipState: "current",
      terminalLaunched: true,
      initialMessageAccepted: true,
      runtimeObservation: "not_observed",
      messagePresentation: "not_observed",
    });
    expect((await teams.readConfig(team)).members).toContainEqual(expect.objectContaining({
      name: "worker",
      membershipId: result.details.membership.membershipId,
      isActive: true,
    }));
  });

  it("ships truthful names for non-mutating session reports and teammate shutdown", () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const tools = registerTools();
    expect(tools.has("report_stale_agent_sessions")).toBe(true);
    expect(tools.has("teammate_shutdown")).toBe(true);
    expect(tools.has("cleanup_agent_sessions")).toBe(false);
    expect(tools.has("process_shutdown_approved")).toBe(false);
    expect(tools.get("report_stale_agent_sessions")!.description).toMatch(/without deleting/i);
  });

  it("previews exact template artifacts without mutation, then writes that exact projection", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const team = uniqueTeam("template");
    const root = temporaryRoot("template");
    const leadSession = path.join(root, "lead.jsonl");
    await teams.createTeam(team, leadSession, "lead");
    await teams.addMember(team, member("worker", path.join(root, "worker.jsonl"), {
      prompt: "Produce a durable result.",
    }));
    const tools = registerTools();
    const params = {
      team_name: team,
      template_name: "ergonomic-template",
      scope: "project",
    };

    const preview = await tools.get("save_team_as_template")!.execute(
      "preview", { ...params, dry_run: true }, undefined, undefined, context(leadSession, root),
    );
    expect(preview.details.dryRun).toBe(true);
    expectDurableReceipt(preview.details.receipt, "save_team_as_template", "team_template");
    expect(preview.details.receipt.postState).toMatchObject({ state: "previewed", dryRun: true });
    expect(preview.details.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "agent_definition", written: false, action: "create" }),
      expect.objectContaining({ kind: "team_manifest", written: false, action: "create" }),
    ]));
    expect(fs.existsSync(path.join(root, ".pi"))).toBe(false);

    const write = await tools.get("save_team_as_template")!.execute(
      "write", { ...params, dry_run: false }, undefined, undefined, context(leadSession, root),
    );
    expect(write.details.dryRun).toBe(false);
    expectDurableReceipt(write.details.receipt, "save_team_as_template", "team_template");
    expect(write.details.receipt.postState).toMatchObject({ state: "written", dryRun: false });
    expect(write.details.artifacts).toEqual(expect.arrayContaining(
      preview.details.artifacts.map((artifact: { path: string; content: string }) =>
        expect.objectContaining({ path: artifact.path, content: artifact.content, written: true }),
      ),
    ));
    for (const artifact of write.details.artifacts as Array<{ path: string; content: string; written: boolean }>) {
      expect(artifact.written).toBe(true);
      expect(fs.readFileSync(artifact.path, "utf8")).toBe(artifact.content);
    }
  });

  it("denies Team topology, lifecycle, and template writes to a worker but preserves Message inspection and send", async () => {
    const team = uniqueTeam("worker-authority");
    const root = temporaryRoot("worker-authority");
    const leadSession = path.join(root, "lead.jsonl");
    const workerSession = path.join(root, "worker.jsonl");
    const otherSession = path.join(root, "other.jsonl");
    await teams.createTeam(team, leadSession, "lead");
    await teams.addMember(team, member("worker", workerSession));
    const other = member("other", otherSession);
    await teams.addMember(team, other);
    setAdapter(terminal());
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.stubEnv("PI_TEAM_NAME", team);
    const tools = registerTools();
    const workerContext = context(workerSession, root);

    for (const [tool, params] of [
      ["spawn_teammate", { team_name: team, name: "new-worker", prompt: "x", cwd: root }],
      ["teammate_shutdown", { team_name: team, agent_name: "other" }],
      ["team_shutdown", { team_name: team }],
      ["save_team_as_template", { team_name: team, template_name: "nope", scope: "project", dry_run: true }],
    ] as const) {
      await expect(tools.get(tool)!.execute(tool, params, undefined, undefined, workerContext))
        .rejects.toThrow(/lead-only/i);
    }

    const sent = await tools.get("send_message")!.execute("send", {
      team_name: team,
      recipient: "team-lead",
      content: "I found a useful constraint.",
      summary: "constraint",
    }, undefined, undefined, workerContext);
    expect(sent.details.messageId).toEqual(expect.any(String));

    await messaging.sendPlainMessage(team, "team-lead", "other", "Please verify this.", "verify");
    const own = await tools.get("read_inbox")!.execute("own", {
      team_name: team,
      unread_only: false,
    }, undefined, undefined, workerContext);
    expect(own.details.messages).toEqual([]);

    const crossMember = await tools.get("read_inbox")!.execute("cross", {
      team_name: team,
      agent_name: "other",
      unread_only: true,
    }, undefined, undefined, workerContext);
    expect(crossMember.details.messages).toEqual([
      expect.objectContaining({ text: "Please verify this.", recipientMembershipId: other.membershipId, read: false }),
    ]);
    const after = await messaging.readInboxForMembership(team, "other", other.membershipId!, true, false);
    expect(after).toEqual([
      expect.objectContaining({ text: "Please verify this.", read: false }),
    ]);
  });

  it("returns the same durable receipt vocabulary for teammate and whole-Team shutdown", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    setAdapter(terminal());
    const team = uniqueTeam("shutdown-receipts");
    const root = temporaryRoot("shutdown-receipts");
    const leadSession = path.join(root, "lead.jsonl");
    await teams.createTeam(team, leadSession, "lead");
    await teams.addMember(team, member("worker", path.join(root, "worker.jsonl"), { tmuxPaneId: "pane-worker" }));
    const tools = registerTools();
    const leadContext = context(leadSession, root);

    const teammate = await tools.get("teammate_shutdown")!.execute("stop-worker", {
      team_name: team,
      agent_name: "worker",
    }, undefined, undefined, leadContext);
    expectDurableReceipt(teammate.details.receipt, "teammate_shutdown", "membership");
    expect(teammate.details.receipt.postState).toMatchObject({ membershipState: "inactive" });

    const wholeTeam = await tools.get("team_shutdown")!.execute("stop-team", {
      team_name: team,
    }, undefined, undefined, leadContext);
    expectDurableReceipt(wholeTeam.details.receipt, "team_shutdown", "team");
    expect(wholeTeam.details.receipt.postState).toMatchObject({
      state: "shut_down",
      taskAuthorityRetained: true,
    });
  });

  it("does not mislabel legacy runtime ready evidence as successful work or delivery", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const aliveTerminal: TerminalAdapter = { ...terminal(), isAlive: () => true };
    setAdapter(aliveTerminal);
    const team = uniqueTeam("runtime-projection");
    const root = temporaryRoot("runtime-projection");
    const leadSession = path.join(root, "lead.jsonl");
    const worker = member("worker", path.join(root, "worker.jsonl"), { tmuxPaneId: "pane-worker" });
    await teams.createTeam(team, leadSession, "lead");
    await teams.addMember(team, worker);
    await runtime.writeRuntimeStatus(team, "worker", {
      ready: true,
      lastHeartbeatAt: Date.now(),
    }, worker.membershipId);
    const tools = registerTools();

    const result = await tools.get("check_teammate")!.execute("check", {
      team_name: team,
      agent_name: "worker",
    }, undefined, undefined, context(leadSession, root));

    expect(result.details).not.toHaveProperty("agentLoopReady");
    expect(result.details).not.toHaveProperty("successfulTurnObserved");
    // The raw compatibility record remains inspectable, but has no promoted
    // semantic interpretation in the agent-facing projection.
    expect(result.details.runtime).toMatchObject({ ready: true, membershipId: worker.membershipId });
  });
});
