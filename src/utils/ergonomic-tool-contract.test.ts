import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import type { TerminalAdapter } from "./terminal-adapter";
import { clearAdapterCache, getTerminalAdapter, setAdapter } from "../adapters/terminal-registry";
import type { Member } from "./models";
import * as paths from "./paths";
import * as teams from "./teams";
import * as teamEvents from "./team-events";
import * as taskAuthority from "./tasks";
import * as runtime from "./runtime";

type RegisteredTool = {
  name: string;
  description: string;
  execute: (toolCallId: string, params: any, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
};

const PUBLIC_TOOLS = [
  "alert_send",
  "task_create",
  "task_link",
  "task_read",
  "task_update",
  "team_create",
  "team_shutdown",
  "team_sync",
  "worker_ensure",
  "worker_stop",
];

const createdTeams: string[] = [];

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function uniqueTeam(suffix: string): string {
  const team = `ergonomic-contract-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(team);
  return team;
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
    isDirectCarrier: () => true,
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

/**
 * Mirror team_create: a Team binds the detected terminal backend at creation,
 * so lifecycle operations resolve it from durable authority instead of ambient
 * detection. Members still carry legacy pane IDs to keep that read covered.
 */
function createBoundTeam(name: string, leadSession: string, separateWindows?: boolean) {
  const detected = getTerminalAdapter();
  return teams.createTeam(
    name,
    leadSession,
    "lead",
    undefined,
    undefined,
    separateWindows,
    undefined,
    undefined,
    undefined,
    undefined,
    detected ? { backend: detected.name } : undefined,
  );
}

function expectEnvelope(
  details: any,
  operation: string,
  resourceKind: "team" | "worker" | "task" | "alert",
  outcome: "accepted" | "partial" | "refused" = "accepted",
) {
  expect(details).toMatchObject({
    schema: "pi-teams-tool-result/1",
    outcome,
    operation,
    resource: { kind: resourceKind, id: expect.any(String) },
    warnings: expect.any(Array),
    nextActions: expect.any(Array),
  });
  expect(JSON.stringify(details)).not.toMatch(/agentLoopReady|successfulTurnObserved|deliveryReady/i);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAdapterCache();
  for (const team of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(team), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(team), { recursive: true, force: true });
  }
});

describe("ergonomic agent-facing Team contracts", () => {
  it("exposes only the ten Task-first lifecycle tools", () => {
    const tools = registerTools();

    expect([...tools.keys()].sort()).toEqual(PUBLIC_TOOLS);
    expect(tools.get("team_sync")!.description).toMatch(/block|wait|event/i);
    expect(tools.get("worker_ensure")!.description).toMatch(/reuse/i);
    expect(tools.get("alert_send")!.description).toMatch(/exceptional/i);
    for (const retired of [
      "spawn_teammate",
      "teammate_shutdown",
      "send_message",
      "broadcast_message",
      "read_inbox",
      "check_teammate",
      "report_stale_agent_sessions",
      "save_team_as_template",
    ]) {
      expect(tools.has(retired)).toBe(false);
    }
  });

  it("returns compact Team and sync envelopes without leaking persisted config into agent content", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const team = uniqueTeam("create-sync");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const tools = registerTools();
    const leadContext = context(leadSession);

    const created = await tools.get("team_create")!.execute(
      "create",
      { team_name: team },
      undefined,
      undefined,
      leadContext,
    );

    expectEnvelope(created.details, "team_create", "team");
    expect(created.details.postState).toEqual({
      name: team,
      lifecycle: "active",
      taskAuthorityReady: true,
      teamDirectory: paths.teamDir(team),
      taskWorkspace: paths.teamDir(team),
      beadsDatabase: expect.any(String),
    });
    expect(created.details.evidence).toMatchObject({
      leadMembershipId: expect.any(String),
      taskAuthority: { backend: "beads", authorityId: expect.any(String) },
    });
    expect(created.details).not.toHaveProperty("config");
    expect(created.content[0].text).toBe(
      `Team ${team} created; Task authority is ready.\n` +
      "Next: use worker_ensure when another capability is needed, or task_create to create the first work contract.",
    );
    expect(created.content[0].text).not.toContain(created.details.evidence.leadMembershipId);
    expect(created.content[0].text).not.toContain(created.details.evidence.taskAuthority.authorityId);
    expect(JSON.stringify(created.details)).not.toContain(leadSession);

    const snapshot = await tools.get("team_sync")!.execute(
      "snapshot",
      { team_name: team },
      undefined,
      undefined,
      leadContext,
    );
    expectEnvelope(snapshot.details, "team_sync", "team");
    expect(snapshot.details.postState).toMatchObject({
      completion: "snapshot",
      cursor: expect.stringMatching(/^[0-9]+$/),
      projection: {
        team: { name: team, lifecycle: "active" },
        workers: [],
        tasks: [],
      },
    });
    expect(snapshot.content[0].text).toMatch(/Workers: none.*Tasks: none/s);
    expect(snapshot.content[0].text).not.toContain(leadSession);

    const cursorAhead = await tools.get("team_sync")!.execute("cursor-ahead", {
      team_name: team,
      cursor: (BigInt(snapshot.details.postState.cursor) + 100n).toString(),
    }, undefined, undefined, leadContext);
    expect(cursorAhead.details).toMatchObject({
      outcome: "refused",
      postState: {
        reason: "cursor_ahead_of_journal",
        journalHeadCursor: snapshot.details.postState.cursor,
        cursorCorrectionRequired: true,
      },
    });
    expect(cursorAhead.content[0].text).toMatch(/no lower cursor was returned as successful progress/i);
    expect(cursorAhead.content[0].text).toMatch(/state are unchanged; no events were consumed or lost/i);

    for (let index = 1; index <= 3; index++) {
      const alert = await tools.get("alert_send")!.execute(`alert-${index}`, {
        team_name: team,
        to: "team-lead",
        kind: "attention",
        text: `Reconcile the current Team projection (${index}).`,
      }, undefined, undefined, leadContext);
      expectEnvelope(alert.details, "alert_send", "alert");
    }

    const changes = await tools.get("team_sync")!.execute("changes", {
      team_name: team,
      cursor: snapshot.details.postState.cursor,
      wait_ms: 50,
      event_types: ["alert"],
      limit: 2,
    }, undefined, undefined, leadContext);
    expectEnvelope(changes.details, "team_sync", "team");
    expect(changes.details.postState.completion).toBe("events");
    expect(changes.details.evidence.events).toHaveLength(2);
    expect(changes.details.postState.pagination.events).toMatchObject({ returned: 2, truncated: true, remaining: 1 });
    expect(changes.details.postState.cursor).not.toBe(changes.details.postState.journalHeadCursor);
    expect(changes.content[0].text).toMatch(/Event page truncated/);

    const finalChanges = await tools.get("team_sync")!.execute("changes-final", {
      team_name: team,
      cursor: changes.details.postState.cursor,
      event_types: ["alert"],
      limit: 2,
    }, undefined, undefined, leadContext);
    expect(finalChanges.details.evidence.events).toEqual([
      expect.objectContaining({ type: "alert", kind: "attention", to: "team-lead" }),
    ]);
    expect(finalChanges.details.postState.pagination.events).toMatchObject({ returned: 1, truncated: false, remaining: 0 });
    expect(finalChanges.details.postState.cursor).toBe(finalChanges.details.postState.journalHeadCursor);

    for (let index = 0; index < 3; index++) {
      await teamEvents.appendTeamEvent(team, {
        type: "worker",
        worker: "reviewer",
        membershipId: "membership-machine-evidence",
        phase: "failed",
      });
    }
    const overflow = await tools.get("team_sync")!.execute("worker-overflow", {
      team_name: team,
      cursor: finalChanges.details.postState.cursor,
      event_types: ["worker"],
      limit: 2,
    }, undefined, undefined, leadContext);
    expect(overflow.content[0].text.match(/Worker reviewer failed ×2/g)).toHaveLength(1);
    expect(overflow.content[0].text).toMatch(/exactly 1 matching event remaining/);
    expect(overflow.content[0].text).not.toMatch(/membership-machine-evidence|carrier/);

    for (let index = 1; index <= 2; index++) {
      await tools.get("task_create")!.execute(`page-task-${index}`, {
        team_name: team,
        title: `Paged Task ${index}`,
        description: `Exercise bounded snapshot page ${index}.`,
      }, undefined, undefined, leadContext);
    }
    const firstSnapshotPage = await tools.get("team_sync")!.execute("snapshot-page-1", {
      team_name: team,
      limit: 1,
    }, undefined, undefined, leadContext);
    expect(firstSnapshotPage.details.postState.pagination.projection).toMatchObject({
      returned: 1,
      totalItems: 2,
      truncated: true,
      continuation: expect.any(String),
    });
    expect(firstSnapshotPage.details.postState.projection.tasks).toHaveLength(1);

    const secondSnapshotPage = await tools.get("team_sync")!.execute("snapshot-page-2", {
      team_name: team,
      limit: 1,
      continuation: firstSnapshotPage.details.postState.pagination.projection.continuation,
    }, undefined, undefined, leadContext);
    expect(secondSnapshotPage.details.postState.pagination.projection).toMatchObject({
      returned: 1,
      totalItems: 2,
      truncated: false,
      continuation: null,
    });
    expect(secondSnapshotPage.details.postState.projection.tasks).toHaveLength(1);
    expect(secondSnapshotPage.details.postState.projection.tasks[0].id)
      .not.toBe(firstSnapshotPage.details.postState.projection.tasks[0].id);
  }, 60_000);

  it("creates or reuses one stable Worker without claiming runtime readiness", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const livePrepared = terminal();
    livePrepared.isAlive = (paneId) => paneId === "pane-worker";
    setAdapter(livePrepared);
    const team = uniqueTeam("worker-reuse");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    await createBoundTeam(team, leadSession);
    const tools = registerTools();
    const params = {
      team_name: team,
      name: "worker",
      profile: "Review interfaces and verify contract tests.",
      cwd: process.cwd(),
    };

    const taskReads = vi.spyOn(taskAuthority, "listTasksWithVersions").mockRejectedValue(new Error("worker_ensure must not read Task authority"));
    const created = await tools.get("worker_ensure")!.execute(
      "ensure-created", params, undefined, undefined, context(leadSession),
    );
    expectEnvelope(created.details, "worker_ensure", "worker");
    expect(created.details.postState).toMatchObject({
      name: "worker",
      action: "created",
      membership: "current",
      carrier: "prepared",
      terminalLaunched: true,
      runtime: "not_observed",
      assignedTasks: [],
    });
    expect(created.details.evidence).toMatchObject({
      membershipId: expect.any(String),
      terminalLaunch: { adapter: "ergonomic-contract-terminal", kind: "pane", targetId: "pane-worker" },
    });
    expect(created.content[0].text).not.toContain(created.details.evidence.membershipId);
    expect(created.content[0].text).not.toContain("pane-worker");

    const reused = await tools.get("worker_ensure")!.execute(
      "ensure-reused", params, undefined, undefined, context(leadSession),
    );
    expectEnvelope(reused.details, "worker_ensure", "worker");
    expect(reused.details.postState).toMatchObject({
      name: "worker",
      action: "reused",
      membership: "current",
    });
    expect(reused.details.evidence.membershipId).toBe(created.details.evidence.membershipId);
    const currentWorkers = (await teams.readConfig(team)).members.filter(
      candidate => candidate.name === "worker" && candidate.isActive !== false,
    );
    expect(currentWorkers).toHaveLength(1);
    expect(taskReads).toHaveBeenCalledTimes(0);
  });

  it("observes the exact Worker binding and runtime during the bounded launch wait", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_TEAMS_WORKER_STARTUP_WAIT_MS", "1000");
    const team = uniqueTeam("worker-startup-observed");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const workerSession = `/tmp/${team}-worker.jsonl`;
    const adapter: TerminalAdapter = {
      ...terminal(),
      spawn: () => {
        queueMicrotask(async () => {
          const prepared = await teams.currentMembership(team, "worker");
          const bound = await teams.bindMemberSession(
            team,
            "worker",
            workerSession,
            prepared.pendingLaunchId,
            {},
            prepared.membershipId,
          );
          const startedAt = Date.now();
          await runtime.writeRuntimeStatus(team, "worker", {
            pid: 4242,
            startedAt,
            ready: false,
          }, bound.membershipId);
          await teamEvents.appendTeamEvent(team, {
            type: "worker",
            worker: "worker",
            membershipId: bound.membershipId!,
            phase: "session_bound",
            generation: { membershipId: bound.membershipId!, pid: 4242, startedAt },
          });
        });
        return "pane-worker";
      },
      isAlive: (paneId) => paneId === "pane-worker",
    };
    setAdapter(adapter);
    await createBoundTeam(team, leadSession);

    const result = await registerTools().get("worker_ensure")!.execute(
      "ensure-observed",
      { team_name: team, name: "worker", profile: "Review interfaces.", cwd: process.cwd() },
      undefined,
      undefined,
      context(leadSession),
    );

    expect(result.details.postState).toMatchObject({
      action: "created",
      carrier: "session_bound",
      runtime: "observed",
    });
    expect(result.details.warnings).toEqual([]);
    expect(result.content[0].text).toMatch(/runtime startup (?:was|were) observed/i);
  });

  it("uses the Team window policy for every new Worker", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const spawnWindow = vi.fn(() => "window-worker");
    const adapter: TerminalAdapter = {
      ...terminal(),
      supportsWindows: () => true,
      spawn: () => { throw new Error("Team window policy was ignored"); },
      spawnWindow,
      isWindowAlive: (windowId) => windowId === "window-worker",
    };
    setAdapter(adapter);
    const team = uniqueTeam("worker-team-window-policy");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    await createBoundTeam(team, leadSession, true);

    await registerTools().get("worker_ensure")!.execute(
      "ensure-window",
      { team_name: team, name: "worker", profile: "Review interfaces.", cwd: process.cwd() },
      undefined,
      undefined,
      context(leadSession),
    );

    expect(spawnWindow).toHaveBeenCalledOnce();
  });

  it("retries a missing prepared carrier with the same unconsumed launch capability", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const spawn = vi.fn((_options: any) => "pane-retried");
    const adapter: TerminalAdapter = {
      ...terminal(),
      spawn,
      isAlive: (paneId) => paneId === "pane-retried",
    };
    setAdapter(adapter);
    const team = uniqueTeam("worker-retry-prepared");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    await createBoundTeam(team, leadSession);
    const pendingLaunchId = teams.newLaunchId();
    const worker: Member = {
      membershipId: teams.newMembershipId(),
      pendingLaunchId,
      agentId: `worker@${team}`,
      name: "worker",
      agentType: "teammate",
      model: "openai-codex/example-model",
      thinking: "medium",
      joinedAt: Date.now(),
      cwd: process.cwd(),
      subscriptions: [],
      prompt: "Review interfaces and verify contract tests.",
      isActive: true,
      terminalTarget: { backend: adapter.name, kind: "pane", targetId: "pane-missing" },
    };
    await teams.addMember(team, worker);
    const taskReads = vi.spyOn(taskAuthority, "listTasksWithVersions").mockRejectedValue(new Error("Task authority must not gate prepared relaunch"));

    const result = await registerTools().get("worker_ensure")!.execute(
      "ensure-prepared-retried",
      {
        team_name: team,
        name: "worker",
        profile: worker.prompt,
        cwd: process.cwd(),
      },
      undefined,
      undefined,
      context(leadSession),
    );

    expect(result.details.postState).toMatchObject({
      name: "worker",
      action: "recovered",
      recoveryMode: "first_binding_retry",
      membership: "current",
      carrier: "prepared",
      taskStateChanged: false,
    });
    const spawnOptions = spawn.mock.calls[0][0];
    expect(spawnOptions.argv).not.toContain("--session");
    expect(spawnOptions.env).toMatchObject({
      PI_TEAM_NAME: team,
      PI_AGENT_NAME: "worker",
      PI_AGENT_LAUNCH_ID: pendingLaunchId,
    });
    const current = await teams.currentMembership(team, "worker");
    expect(current).toMatchObject({
      membershipId: worker.membershipId,
      pendingLaunchId,
      terminalTarget: { backend: adapter.name, kind: "pane", targetId: "pane-retried" },
    });
    expect(taskReads).toHaveBeenCalledTimes(0);
  });

  it("recovers a missing carrier by resuming the exact bound Session without reading Task authority", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_LAUNCH_ID", "stale-parent-launch");
    const spawn = vi.fn((_options: any) => "pane-recovered");
    const adapter: TerminalAdapter = {
      ...terminal(),
      spawn,
      isAlive: (paneId) => paneId === "pane-recovered",
    };
    setAdapter(adapter);
    const team = uniqueTeam("worker-recover");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const workerSession = `/tmp/${team}-worker.jsonl`;
    await createBoundTeam(team, leadSession);
    const worker = member("worker", workerSession, {
      model: "openai-codex/example-model",
      thinking: "medium",
      terminalTarget: { backend: adapter.name, kind: "pane", targetId: "pane-missing" },
    });
    await teams.addMember(team, worker);
    const taskReads = vi.spyOn(taskAuthority, "listTasksWithVersions").mockRejectedValue(new Error("Task authority must not gate carrier recovery"));

    const result = await registerTools().get("worker_ensure")!.execute(
      "ensure-recovered",
      {
        team_name: team,
        name: "worker",
        profile: "Review interfaces and verify contract tests.",
        cwd: process.cwd(),
      },
      undefined,
      undefined,
      context(leadSession),
    );

    expect(result.details.postState).toMatchObject({
      name: "worker",
      action: "recovered",
      recoveryMode: "exact_session_resume",
      membership: "current",
      carrier: "session_bound",
      terminalLaunched: true,
      runtime: "not_observed",
      taskStateChanged: false,
    });
    expect(result.content[0].text).toContain("resuming its exact Session");
    const spawnOptions = spawn.mock.calls[0][0];
    expect(spawnOptions.argv).toEqual(expect.arrayContaining([
      "--model", "openai-codex/example-model:medium", "--session", workerSession,
    ]));
    expect(spawnOptions.env).toMatchObject({ PI_TEAM_NAME: team, PI_AGENT_NAME: "worker" });
    expect(spawnOptions.env).not.toHaveProperty("PI_AGENT_LAUNCH_ID");
    const current = (await teams.readConfig(team)).members.filter(candidate =>
      candidate.name === "worker" && candidate.isActive !== false);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      membershipId: worker.membershipId,
      sessionFile: workerSession,
      terminalTarget: { backend: adapter.name, kind: "pane", targetId: "pane-recovered" },
    });
    expect(taskReads).toHaveBeenCalledTimes(0);
  });

  it("compensates a failed exact-Session recovery without replacing the current Membership", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const live = new Set<string>();
    const kill = vi.fn((paneId: string) => live.delete(paneId));
    const adapter: TerminalAdapter = {
      ...terminal(),
      spawn: vi.fn(() => {
        live.add("pane-recovery-attempt");
        return "pane-recovery-attempt";
      }),
      kill,
      isAlive: (paneId) => live.has(paneId),
    };
    setAdapter(adapter);
    const team = uniqueTeam("worker-recover-compensate");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const workerSession = `/tmp/${team}-worker.jsonl`;
    await createBoundTeam(team, leadSession);
    const worker = member("worker", workerSession, {
      terminalTarget: { backend: adapter.name, kind: "pane", targetId: "pane-gone" },
    });
    await teams.addMember(team, worker);
    vi.spyOn(teams, "bindMemberSession").mockRejectedValueOnce(new Error("simulated stale recovery binding"));

    await expect(registerTools().get("worker_ensure")!.execute(
      "ensure-recovery-fails",
      {
        team_name: team,
        name: "worker",
        profile: "Review interfaces and verify contract tests.",
        cwd: process.cwd(),
      },
      undefined,
      undefined,
      context(leadSession),
    )).rejects.toThrow(/existing Membership and exact Session binding remain current/);

    expect(kill).toHaveBeenCalledWith("pane-recovery-attempt");
    expect(live.has("pane-recovery-attempt")).toBe(false);
    const current = (await teams.readConfig(team)).members.filter(candidate =>
      candidate.name === "worker" && candidate.isActive !== false);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      membershipId: worker.membershipId,
      sessionFile: workerSession,
      terminalTarget: { backend: adapter.name, kind: "pane", targetId: "pane-gone" },
    });
  });

  it("keeps lifecycle writes lead-only while workers use typed Alerts without an inbox inspection surface", async () => {
    const team = uniqueTeam("worker-authority");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const workerSession = `/tmp/${team}-worker.jsonl`;
    await teams.createTeam(team, leadSession, "lead");
    await teams.addMember(team, member("worker", workerSession));
    setAdapter(terminal());
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.stubEnv("PI_TEAM_NAME", team);
    const tools = registerTools();
    const workerContext = context(workerSession);

    for (const [tool, params] of [
      ["worker_ensure", { team_name: team, name: "other", profile: "x", cwd: process.cwd() }],
      ["worker_stop", { team_name: team, worker: "worker" }],
      ["team_shutdown", { team_name: team }],
    ] as const) {
      await expect(tools.get(tool)!.execute(tool, params, undefined, undefined, workerContext))
        .rejects.toThrow(/lead-only/i);
    }

    const sent = await tools.get("alert_send")!.execute("send", {
      team_name: team,
      to: "team-lead",
      kind: "clarification",
      text: "Does the acceptance criterion include the restart case?",
    }, undefined, undefined, workerContext);
    expectEnvelope(sent.details, "alert_send", "alert");
    expect(sent.details.postState).toMatchObject({
      kind: "clarification",
      from: "worker",
      to: "team-lead",
      recipients: ["team-lead"],
      taskStateChanged: false,
    });
    expect(sent.details.evidence.deliveries[0].messageId).toEqual(expect.any(String));
    expect(sent.content[0].text).not.toContain(sent.details.resource.id);
    expect(sent.content[0].text).not.toContain(sent.details.evidence.deliveries[0].messageId);
    expect(JSON.stringify(sent.details)).not.toContain(workerSession);
    expect(tools.has("read_inbox")).toBe(false);
  });

  it("does not echo a rejected Task description into the acceptance-criteria retry", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    setAdapter(terminal());
    const team = uniqueTeam("criteria-retry");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const tools = registerTools();
    const leadContext = context(leadSession);
    await tools.get("team_create")!.execute(
      "create", { team_name: team }, undefined, undefined, leadContext,
    );
    await tools.get("worker_ensure")!.execute("ensure", {
      team_name: team,
      name: "worker",
      profile: "Implement and independently verify assigned Tasks.",
      cwd: process.cwd(),
    }, undefined, undefined, leadContext);

    const rejectedDescription = "Do not copy this underspecified prompt body into retry arguments.";
    const refused = await tools.get("task_create")!.execute("missing-criteria", {
      team_name: team,
      title: "Underspecified assigned work",
      description: rejectedDescription,
      assignee: "worker",
    }, undefined, undefined, leadContext);

    expect(refused.details).toMatchObject({
      outcome: "refused",
      operation: "task_create",
      postState: {
        created: false,
        taskStateChanged: false,
        reason: "acceptance_criteria_required",
      },
      nextActions: [{
        tool: "task_create",
        reason: expect.stringMatching(/add independently verifiable acceptance criteria before retrying/i),
        args: {
          team_name: team,
          title: "Underspecified assigned work",
          assignee: "worker",
        },
      }],
    });
    expect(refused.details.nextActions[0].args).not.toHaveProperty("description");
    expect(JSON.stringify(refused.details.nextActions)).not.toContain(rejectedDescription);
  }, 60_000);

  it("binds goal-driven Task state to Worker and Team lifecycle receipts", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    setAdapter(terminal());
    const team = uniqueTeam("task-lifecycle");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const tools = registerTools();
    const leadContext = context(leadSession);
    await tools.get("team_create")!.execute(
      "create", { team_name: team }, undefined, undefined, leadContext,
    );
    await tools.get("worker_ensure")!.execute("ensure", {
      team_name: team,
      name: "worker",
      profile: "Implement and independently verify the assigned goal.",
      cwd: process.cwd(),
    }, undefined, undefined, leadContext);

    const task = await tools.get("task_create")!.execute("task", {
      team_name: team,
      title: "Verify restart persistence",
      description: "Exercise the durable restart path and record evidence.",
      acceptance_criteria: "A fresh store reads the committed terminal state.",
      assignee: "worker",
    }, undefined, undefined, leadContext);
    expectEnvelope(task.details, "task_create", "task");
    expect(task.details.postState).toMatchObject({
      title: "Verify restart persistence",
      acceptanceCriteria: "A fresh store reads the committed terminal state.",
      assignee: "worker",
      status: "open",
      version: expect.any(String),
    });

    const lifecycleTaskReads = vi.spyOn(taskAuthority, "listTasksWithVersions");
    const guarded = await tools.get("worker_stop")!.execute("guarded-stop", {
      team_name: team,
      worker: "worker",
    }, undefined, undefined, leadContext);
    expectEnvelope(guarded.details, "worker_stop", "worker", "refused");
    expect(guarded.details.postState).toMatchObject({
      worker: "worker",
      changed: false,
      reason: "nonterminal_tasks_assigned",
      membership: "current",
      guardingTasks: [{ id: task.details.postState.id, status: "open" }],
    });
    expect(lifecycleTaskReads).toHaveBeenCalledTimes(1);
    expect(lifecycleTaskReads).toHaveBeenCalledWith(team, { assignee: "worker", nonterminalOnly: true });

    const closed = await tools.get("task_update")!.execute("close", {
      team_name: team,
      task_id: task.details.postState.id,
      status: "closed",
      append_note: "Restarted the store and verified the committed terminal state.",
      expected_version: task.details.postState.version,
    }, undefined, undefined, leadContext);
    expectEnvelope(closed.details, "task_update", "task");
    expect(closed.details.postState).toMatchObject({ status: "closed", assignee: "worker" });
    expect(closed.details.evidence.appliedOperations).toEqual(["set:status", "append:note"]);

    const stopped = await tools.get("worker_stop")!.execute("stop", {
      team_name: team,
      worker: "worker",
    }, undefined, undefined, leadContext);
    expectEnvelope(stopped.details, "worker_stop", "worker");
    expect(stopped.details.postState).toEqual({
      worker: "worker",
      membership: "inactive",
      taskStateChanged: false,
    });

    const shutdown = await tools.get("team_shutdown")!.execute("shutdown", {
      team_name: team,
    }, undefined, undefined, leadContext);
    expectEnvelope(shutdown.details, "team_shutdown", "team");
    expect(shutdown.details.postState).toMatchObject({
      lifecycle: "shut_down",
      shutdownOutcome: "complete",
      currentMembers: [],
      unfinishedTasks: [],
      taskAuthorityRetained: true,
    });
  }, 60_000);
});
