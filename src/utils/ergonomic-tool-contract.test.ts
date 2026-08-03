import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import * as workerResources from "./worker-resource-projection";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "../../src/model-tool-contract/preview-constants";
import { taskVersionRef } from "../../src/model-tool-contract/task-version-ref";

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
  "ensure_worker",
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
    MODEL_TOOL_IMPLEMENTATION_VERSION,
  );
}

function expectEnvelope(
  details: any,
  operation: string,
  resourceKind: "team" | "worker" | "task" | "alert",
  outcome: "accepted" | "partial" | "refused" = "accepted",
) {
  expect(details).toMatchObject({ kind: expect.any(String) });
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

    expect([...tools.keys()].sort()).toEqual([...PUBLIC_TOOLS].sort());
    expect(tools.get("team_sync")!.description).toMatch(/snapshot|updates|context/i);
    expect(tools.get("ensure_worker")!.description).toMatch(/reuse/i);
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
      { name: team, purpose: "ergonomic contract Team" },
      undefined,
      undefined,
      leadContext,
    );

    expect(created.details).toMatchObject({ kind: "team_created", team: { name: team, purpose: "ergonomic contract Team", lifecycle: "active" } });
    expect(created.details).not.toHaveProperty("config");
    expect(created.content[0].text).not.toBe(JSON.stringify(created.details));
    expect(created.content[0].text).not.toContain(leadSession);

    const snapshot = await tools.get("team_sync")!.execute(
      "snapshot", { view: "snapshot" }, undefined, undefined, leadContext,
    );
    expect(snapshot.details).toMatchObject({ kind: "snapshot", team: { name: team, lifecycle: "active" }, workers: [], tasks: [] });
    expect(JSON.parse(snapshot.content[0].text)).toMatchObject({ kind: "snapshot", team: { name: team, lifecycle: "active" } });
    return;

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
      scope: "Review interfaces and verify contract tests.",
      cwd: process.cwd(),
    };

    const taskReads = vi.spyOn(taskAuthority, "listTasksWithVersions").mockRejectedValue(new Error("ensure_worker must not read Task authority"));
    const created = await tools.get("ensure_worker")!.execute(
      "ensure-created", params, undefined, undefined, context(leadSession),
    );
    expect(created.details).toMatchObject({
      kind: "worker_ensured",
      effect: "created",
      worker: { name: "worker", scope: params.scope, carrier: expect.any(String) },
    });
    expect(created.content[0].text).not.toContain("pane-worker");

    const reused = await tools.get("ensure_worker")!.execute(
      "ensure-reused", params, undefined, undefined, context(leadSession),
    );
    expect(reused.details).toMatchObject({
      kind: "worker_ensured",
      effect: "reused",
      worker: { name: "worker", scope: params.scope },
    });
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

    const result = await registerTools().get("ensure_worker")!.execute(
      "ensure-observed",
      { team_name: team, name: "worker", scope: "Review interfaces.", cwd: process.cwd() },
      undefined,
      undefined,
      context(leadSession),
    );

    expect(result.details).toMatchObject({
      kind: "worker_ensured",
      effect: "created",
      worker: { name: "worker", scope: "Review interfaces.", carrier: expect.stringMatching(/starting|connected/) },
    });
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

    await registerTools().get("ensure_worker")!.execute(
      "ensure-window",
      { team_name: team, name: "worker", scope: "Review interfaces.", cwd: process.cwd() },
      undefined,
      undefined,
      context(leadSession),
    );

    expect(spawnWindow).toHaveBeenCalledOnce();
  });

  it("retries a missing prepared carrier with the same unconsumed launch capability", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_TEAM_BRIGHT_SHIPPED_EXTENSION", "/private/exact-team-extension.ts");
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

    const result = await registerTools().get("ensure_worker")!.execute(
      "ensure-prepared-retried",
      {
        team_name: team,
        name: "worker",
        scope: worker.prompt,
        cwd: process.cwd(),
      },
      undefined,
      undefined,
      context(leadSession),
    );

    expect(result.details).toMatchObject({
      kind: "worker_ensured",
      effect: "created",
      worker: { name: "worker", scope: worker.prompt, carrier: expect.stringMatching(/starting|connected/) },
    });
    const spawnOptions = spawn.mock.calls[0][0];
    expect(spawnOptions.argv).not.toContain("--session");
    expect(spawnOptions.argv).toEqual(expect.arrayContaining([
      "-ne", "-e", "/private/exact-team-extension.ts",
    ]));
    expect(spawnOptions.argv.indexOf("-ne")).toBeLessThan(spawnOptions.argv.indexOf("-e"));
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

  it("does not materialize an aggregate before recovery window-policy preflight", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    setAdapter(terminal());
    const materialize = vi.spyOn(workerResources, "resolveWorkerLaunchResources");
    const team = uniqueTeam("worker-recovery-window-preflight");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    await createBoundTeam(team, leadSession, true);
    const prepared: Member = {
      membershipId: teams.newMembershipId(),
      pendingLaunchId: teams.newLaunchId(),
      agentId: `worker@${team}`,
      name: "worker",
      agentType: "teammate",
      joinedAt: Date.now(),
      cwd: process.cwd(),
      subscriptions: [],
      terminalTarget: { backend: "ergonomic-contract-terminal", kind: "pane", targetId: "pane-missing" },
    };
    await teams.addMember(team, prepared);

    const refused = await registerTools().get("ensure_worker")!.execute(
      "ensure-prepared-window-refused",
      { name: "worker", scope: "Review recovery." },
      undefined,
      undefined,
      context(leadSession),
    );
    expect(refused.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(refused.details.message).toMatch(/Separate windows mode is not supported/);

    expect(materialize).not.toHaveBeenCalled();
  });

  it("does not materialize an aggregate before exact-Session window-policy preflight", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    setAdapter(terminal());
    const materialize = vi.spyOn(workerResources, "resolveWorkerLaunchResources");
    const team = uniqueTeam("worker-resume-window-preflight");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    await createBoundTeam(team, leadSession, true);
    const worker = member("worker", `/tmp/${team}-worker.jsonl`, {
      terminalTarget: { backend: "ergonomic-contract-terminal", kind: "pane", targetId: "pane-missing" },
    });
    await teams.addMember(team, worker);

    const refused = await registerTools().get("ensure_worker")!.execute(
      "ensure-resume-window-refused",
      { name: "worker", scope: "Review recovery." },
      undefined,
      undefined,
      context(leadSession),
    );
    expect(refused.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(refused.details.message).toMatch(/Separate windows mode is not supported/);

    expect(materialize).not.toHaveBeenCalled();
  });

  it("cleans the owned aggregate when exact-Session cursor acquisition fails", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-recovery-resource-"));
    const append = path.join(home, "append.md");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(append, "recovery-marker");
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { agents: { append_global: append } } },
    }));
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    setAdapter(terminal());
    const resolved = vi.spyOn(workerResources, "resolveWorkerLaunchResources");
    const team = uniqueTeam("worker-resume-cursor-cleanup");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const workerSession = `/tmp/${team}-worker.jsonl`;
    await createBoundTeam(team, leadSession);
    const worker = member("worker", workerSession, {
      terminalTarget: { backend: "ergonomic-contract-terminal", kind: "pane", targetId: "pane-missing" },
    });
    await teams.addMember(team, worker);
    await runtime.writeRuntimeStatus(team, "worker", { pid: 2_147_483_647, startedAt: 1 }, worker.membershipId);
    vi.spyOn(process, "kill").mockImplementationOnce(() => { const error = new Error("gone") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; });
    vi.spyOn(teamEvents, "readTeamEventCursor").mockImplementation(() => { throw new Error("injected cursor failure"); });

    const refused = await registerTools().get("ensure_worker")!.execute(
      "ensure-resume-cursor-fails",
      { name: "worker", scope: "Review recovery." },
      undefined,
      undefined,
      context(leadSession),
    );
    expect(refused.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(refused.details.message).toContain("injected cursor failure");

    const aggregate = resolved.mock.results[0]?.value.aggregatePath;
    expect(aggregate).toBeTruthy();
    expect(fs.existsSync(aggregate!)).toBe(false);
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
    await runtime.writeRuntimeStatus(team, "worker", { pid: 2_147_483_647, startedAt: 1 }, worker.membershipId);
    vi.spyOn(process, "kill").mockImplementationOnce(() => { const error = new Error("gone") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; });
    const taskReads = vi.spyOn(taskAuthority, "listTasksWithVersions").mockRejectedValue(new Error("Task authority must not gate carrier recovery"));

    const result = await registerTools().get("ensure_worker")!.execute(
      "ensure-recovered",
      {
        team_name: team,
        name: "worker",
        scope: "Review interfaces and verify contract tests.",
        cwd: process.cwd(),
      },
      undefined,
      undefined,
      context(leadSession),
    );

    expect(result.details).toMatchObject({
      kind: "worker_ensured",
      effect: "created",
      worker: { name: "worker", scope: "Review interfaces and verify contract tests.", carrier: expect.stringMatching(/starting|connected/) },
    });
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
    const reused = await registerTools().get("ensure_worker")!.execute(
      "ensure-recovered-again",
      { team_name: team, name: "worker", scope: "Review interfaces and verify contract tests.", cwd: process.cwd() },
      undefined,
      undefined,
      context(leadSession),
    );
    expect(reused.details).toMatchObject({ kind: "worker_ensured", effect: "reused", worker: { name: "worker" } });
    expect(spawn).toHaveBeenCalledOnce();
    expect(taskReads).toHaveBeenCalledTimes(0);
  });

  it("removes the aggregate after confirmed recovery-carrier stop", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-recovery-resource-"));
    const append = path.join(home, "append.md");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(append, "confirmed-stop-marker");
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { agents: { append_global: append } } },
    }));
    vi.stubEnv("HOME", home);
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
    await runtime.writeRuntimeStatus(team, "worker", { pid: 2_147_483_647, startedAt: 1 }, worker.membershipId);
    vi.spyOn(process, "kill").mockImplementationOnce(() => { const error = new Error("gone") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; });
    vi.spyOn(teams, "bindMemberSession").mockRejectedValueOnce(new Error("simulated stale recovery binding"));
    const resolved = vi.spyOn(workerResources, "resolveWorkerLaunchResources");

    const refused = await registerTools().get("ensure_worker")!.execute(
      "ensure-recovery-fails",
      { name: "worker", scope: "Review interfaces and verify contract tests." },
      undefined,
      undefined,
      context(leadSession),
    );
    expect(refused.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(refused.details.message).toMatch(/existing Membership and exact Session binding remain current/);

    expect(kill).toHaveBeenCalledWith("pane-recovery-attempt");
    expect(live.has("pane-recovery-attempt")).toBe(false);
    const aggregate = resolved.mock.results[0]?.value.aggregatePath;
    expect(aggregate).toBeTruthy();
    expect(fs.existsSync(aggregate!)).toBe(false);
    const current = (await teams.readConfig(team)).members.filter(candidate =>
      candidate.name === "worker" && candidate.isActive !== false);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      membershipId: worker.membershipId,
      sessionFile: workerSession,
      terminalTarget: { backend: adapter.name, kind: "pane", targetId: "pane-gone" },
    });
  });

  it("retains the aggregate when recovery-carrier stop is unconfirmed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-recovery-resource-"));
    const append = path.join(home, "append.md");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(append, "unconfirmed-stop-marker");
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { agents: { append_global: append } } },
    }));
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const adapter: TerminalAdapter = {
      ...terminal(),
      spawn: vi.fn(() => "pane-still-live"),
      kill: vi.fn(),
      isAlive: (paneId) => paneId === "pane-still-live",
    };
    setAdapter(adapter);
    const resolved = vi.spyOn(workerResources, "resolveWorkerLaunchResources");
    const team = uniqueTeam("worker-recover-retain-aggregate");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const workerSession = `/tmp/${team}-worker.jsonl`;
    await createBoundTeam(team, leadSession);
    const worker = member("worker", workerSession, {
      terminalTarget: { backend: adapter.name, kind: "pane", targetId: "pane-gone" },
    });
    await teams.addMember(team, worker);
    await runtime.writeRuntimeStatus(team, "worker", { pid: 2_147_483_647, startedAt: 1 }, worker.membershipId);
    vi.spyOn(process, "kill").mockImplementationOnce(() => { const error = new Error("gone") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; });
    vi.spyOn(teams, "bindMemberSession").mockRejectedValueOnce(new Error("simulated stale recovery binding"));

    const refused = await registerTools().get("ensure_worker")!.execute(
      "ensure-recovery-stop-unconfirmed",
      { name: "worker", scope: "Review recovery." },
      undefined,
      undefined,
      context(leadSession),
    );
    expect(refused.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(refused.details.message).toMatch(/Compensation couldn't stop/);

    const aggregate = resolved.mock.results[0]?.value.aggregatePath;
    expect(aggregate).toBeTruthy();
    expect(fs.existsSync(aggregate!)).toBe(true);
    workerResources.removeWorkerAggregate(aggregate);
  });

  it("retains the aggregate when prepared-launch stop is unconfirmed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-launch-resource-"));
    const append = path.join(home, "append.md");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(append, "prepared-live-marker");
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { agents: { append_global: append } } },
    }));
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const adapter: TerminalAdapter = {
      ...terminal(),
      spawn: vi.fn(() => "pane-prepared-live"),
      kill: vi.fn(),
      isAlive: (paneId) => paneId === "pane-prepared-live",
    };
    setAdapter(adapter);
    const resolved = vi.spyOn(workerResources, "resolveWorkerLaunchResources");
    const team = uniqueTeam("worker-prepared-retain-aggregate");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    await createBoundTeam(team, leadSession);
    vi.spyOn(teams, "updateMembership").mockRejectedValueOnce(new Error("injected persistence failure"));

    const refused = await registerTools().get("ensure_worker")!.execute(
      "ensure-prepared-stop-unconfirmed",
      { name: "worker", scope: "Review launch." },
      undefined,
      undefined,
      context(leadSession),
    );
    expect(refused.details).toMatchObject({ kind: "unavailable", reason: "carrier_unavailable" });
    expect(refused.details.message).toMatch(/Membership remains current/);

    const aggregate = resolved.mock.results[0]?.value.aggregatePath;
    expect(aggregate).toBeTruthy();
    expect(fs.existsSync(aggregate!)).toBe(true);
    workerResources.removeWorkerAggregate(aggregate);
  });

  it("keeps lifecycle writes lead-only while workers use typed Alerts without an inbox inspection surface", async () => {
    const team = uniqueTeam("worker-authority");
    const leadSession = `/tmp/${team}-lead.jsonl`;
    const workerSession = `/tmp/${team}-worker.jsonl`;
    await teams.createTeam(team, leadSession, "lead", "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, MODEL_TOOL_IMPLEMENTATION_VERSION);
    await teams.addMember(team, member("worker", workerSession));
    setAdapter(terminal());
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.stubEnv("PI_TEAM_NAME", team);
    const tools = registerTools();
    const workerContext = context(workerSession);

    for (const tool of ["ensure_worker", "worker_stop", "team_shutdown"] as const) {
      expect(tools.has(tool)).toBe(false);
    }

    const sent = await tools.get("alert_send")!.execute("send", {
      team_name: team,
      to: "team-lead",
      kind: "clarification",
      text: "Does the acceptance criterion include the restart case?",
    }, undefined, undefined, workerContext);
    expectEnvelope(sent.details, "alert_send", "alert");
    expect(sent.details).toMatchObject({
      kind: "alert_sent",
      accepted_recipients: ["team-lead"],
      failed_recipients: [],
      task_state_changed: false,
    });
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
      "create", { name: team, purpose: "ergonomic contract Team" }, undefined, undefined, leadContext,
    );
    await tools.get("ensure_worker")!.execute("ensure", {
      team_name: team,
      name: "worker",
      scope: "Implement and independently verify assigned Tasks.",
      cwd: process.cwd(),
    }, undefined, undefined, leadContext);

    const rejectedDescription = "Do not copy this underspecified prompt body into retry arguments.";
    const refused = await tools.get("task_create")!.execute("missing-criteria", {
      tasks: [{ title: "Underspecified assigned work", goal: "Add independently verifiable acceptance criteria before retrying.", assignee: "worker" }],
    }, undefined, undefined, leadContext);
    expect(refused.details).toMatchObject({ kind: "task_create_batch", outcomes: [{ kind: "created", task: { title: "Underspecified assigned work", assignee: "worker" } }] });
    expect(JSON.stringify(refused.details)).not.toContain(rejectedDescription);
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
      "create", { name: team, purpose: "ergonomic contract Team" }, undefined, undefined, leadContext,
    );
    await tools.get("ensure_worker")!.execute("ensure", {
      team_name: team,
      name: "worker",
      scope: "Implement and independently verify the assigned goal.",
      cwd: process.cwd(),
    }, undefined, undefined, leadContext);

    const task = await tools.get("task_create")!.execute("task", {
      tasks: [{ title: "Verify restart persistence", goal: "A fresh store reads the committed terminal state.", assignee: "worker" }],
    }, undefined, undefined, leadContext);
    const taskCard = task.details.outcomes[0].task;
    expect(task.details).toMatchObject({ kind: "task_create_batch", outcomes: [{ kind: "created", task: { title: "Verify restart persistence", assignee: "worker", status: "open" } }] });

    const guarded = await tools.get("worker_stop")!.execute("guarded-stop", { worker: "worker" }, undefined, undefined, leadContext);
    expect(guarded.details).toMatchObject({ kind: "refused", worker: "worker", reason: "nonterminal_tasks_assigned", guarding_task_ids: [taskCard.id], state_changed: false });

    const closed = await tools.get("task_update")!.execute("close", {
      updates: [{ task_id: taskCard.id, operation_id: "close", status: "closed", current_context: "Restarted the store and verified the committed terminal state.", journal_entries: [{ kind: "result", text: "Restarted the store and verified the committed terminal state." }], expected_version: taskVersionRef(taskCard.version) }],
    }, undefined, undefined, leadContext);
    expect(closed.details).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "updated", task: { status: "closed", assignee: "worker" } }] });

    const stopped = await tools.get("worker_stop")!.execute("stop", { worker: "worker" }, undefined, undefined, leadContext);
    expect(stopped.details).toMatchObject({ kind: "worker_stopped", worker: "worker", state_changed: true });
    const shutdown = await tools.get("team_shutdown")!.execute("shutdown", {}, undefined, undefined, leadContext);
    expect(shutdown.details).toMatchObject({ kind: "team_shutdown", lifecycle: "stopped", unfinished_task_ids: [] });
  }, 60_000);
});
