import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as alerts from "../utils/alerts";
import * as paths from "../utils/paths";
import * as authority from "./beads-authority-adapter";
import * as teamEvents from "../utils/team-events";
import * as teams from "../utils/teams";
import { DurableModelToolTeamPort, type ModelToolLifecycle } from "./durable-model-tool-port";
import { exactLeaderSessionId } from "./in-memory-team-port";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "./model-tool-constants";
import { TASK_METADATA_SCHEMA } from "../utils/beads";
import { readHiddenObservationProjection } from "../utils/hidden-observation";
import { registerModelToolJourney } from "./pi-registration";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import { taskVersionRef } from "./task-version-ref";

const testTeams: string[] = [];
const paneSettingsRoots: string[] = [];

function teamName(suffix: string): string {
  const name = `durable-model-tool-fence-${suffix}-${process.pid}-${Date.now()}-${testTeams.length}`;
  testTeams.push(name);
  return name;
}

async function foreignPort(implementationVersion: string | undefined) {
  const name = teamName(implementationVersion ? "foreign" : "legacy");
  const sessionFile = `/tmp/${name}-lead.jsonl`;
  await teams.createTeam(
    name,
    sessionFile,
    "lead-agent",
    "version-fence fixture",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    implementationVersion,
  );
  const config = await teams.readConfig(name);
  config.logicalWorkers = [{ name: "worker", scope: "fixture scope" }];
  teams.writeConfigAtomic(paths.configPath(name), config);

  const launchBridge = { ensureWorker: vi.fn() };
  const lifecycle: ModelToolLifecycle = {
    stopWorker: vi.fn(),
    shutdownTeam: vi.fn(),
  };
  const port = new DurableModelToolTeamPort(launchBridge as any, lifecycle);
  const leaderSessionId = exactLeaderSessionId(`session-${name}`);
  port.setLeaderSessionFile(leaderSessionId, sessionFile);
  return { name, port, leaderSessionId, launchBridge, lifecycle };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearAdapterCache();
  for (const name of testTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
  for (const root of paneSettingsRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function createTeamWithPaneSettings(projectTrusted?: boolean): Promise<{ result: any; createArgs: any[] }> {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "pi-team-pane-settings-"));
  paneSettingsRoots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "leader-project");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
    pi_team_bright: { team: { pane_layout: { leader_share: 0.7, worker_tiling: "grid" } } },
  }));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  setAdapter({
    name: "herdr",
    isDirectCarrier: () => true,
    detect: () => true,
    currentTargetId: () => "leader-pane",
    spawn: () => "worker-pane",
    kill() {},
    isAlive: () => true,
    setTitle() {},
    supportsWindows: () => false,
    spawnWindow: () => { throw new Error("unused"); },
    setWindowTitle() {},
    killWindow() {},
    isWindowAlive: () => false,
  });
  vi.spyOn(teams, "resolveCurrentLeadSessionBinding").mockResolvedValue({ status: "abstain", reason: "not_bound" });
  vi.spyOn(authority, "resolveTeamTaskAuthority").mockResolvedValue({
    workspace: path.join(root, "tasks"), authorityId: "authority-pane-settings", fingerprint: {} as any,
  });
  let createArgs: any[] | undefined;
  vi.spyOn(teams, "createTeam").mockImplementation(async (...args: any[]) => {
    createArgs = args;
    return { name: args[0], description: args[3], members: [] } as any;
  });
  const port = new DurableModelToolTeamPort({ ensureWorker: vi.fn() } as any);
  const leaderSessionId = exactLeaderSessionId(`pane-settings-${Date.now()}-${Math.random()}`);
  port.setLeaderSessionFile(leaderSessionId, path.join(root, "leader.jsonl"));
  port.setLeaderLaunchContext(leaderSessionId, { cwd, projectTrusted });
  const result = await port.createTeam(leaderSessionId, { name: `pane-settings-${Date.now()}`, purpose: "Test pane settings." });
  if (!createArgs) throw new Error("Team creation was not invoked.");
  return { result, createArgs };
}

describe("DurableModelToolTeamPort pane settings", () => {
  it.each([
    [false, undefined, "linear", 0.6],
    [true, "grid", "grid", 0.7],
    [undefined, "grid", "grid", 0.7],
  ] as const)("uses exact ExtensionContext trust (%s)", async (projectTrusted, expectedTiling, tiling, share) => {
    const { result, createArgs } = await createTeamWithPaneSettings(projectTrusted);
    expect(result).toMatchObject({ kind: "created" });
    expect(createArgs[12]).toEqual({ leader_share: share, worker_tiling: tiling });
    if (expectedTiling === undefined) expect(createArgs[12].worker_tiling).toBe("linear");
  });
});

describe("DurableModelToolTeamPort implementation fence", () => {
  it("tolerates one externally oversized Task without rejecting the snapshot", async () => {
    const { port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    vi.spyOn(authority, "listTaskIds").mockResolvedValue(["invalid-task"]);
    vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([{
      task: {
        id: "invalid-task",
        title: "Invalid external context",
        description: "Compatibility text",
        acceptanceCriteria: "Compatibility text",
        status: "open",
        relations: [],
        version: "beads_invalid_task",
        provenance: { authority: "beads", teamName: testTeams[testTeams.length - 1] },
      },
      taskMetadata: {
        schema: TASK_METADATA_SCHEMA,
        goal: "Keep the Team observation coherent.",
        current_context: "👩🏽‍🚀".repeat(2_001),
      },
    }]);

    await expect(port.readSnapshot(leaderSessionId)).resolves.toMatchObject({
      kind: "snapshot",
      tasks: [{ id: "invalid-task", projection_warnings: [{ task_id: "invalid-task", truncated_fields: ["current_context"] }] }],
      taskProjectionWarnings: [{ task_id: "invalid-task", truncated_fields: ["current_context"] }],
    });
    await expect(port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "invalid-snapshot")).resolves.toMatchObject({
      kind: "snapshot",
      tasks: [{ id: "invalid-task", projection_warnings: [{ task_id: "invalid-task", truncated_fields: ["current_context"] }] }],
      taskProjectionWarnings: [{ task_id: "invalid-task", truncated_fields: ["current_context"] }],
    });
    expect(port.getPendingObservation(leaderSessionId)).toBeDefined();
  });

  it.each([true, false])("propagates leader cwd and explicit trust through model-tool registration (%s)", async (projectTrusted) => {
    const { name, port, leaderSessionId, launchBridge } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    const cwd = path.join(paths.teamDir(name), "leader-cwd");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      pi_team_bright: { worker: { default_model: "project/model" } },
    }));
    launchBridge.ensureWorker.mockResolvedValue({
      action: "created",
      member: { name: "worker", agentType: "teammate", sessionFile: "/tmp/model-tool-worker.jsonl" },
      membershipId: "membership-model-tool",
      target: { backend: "fixture", kind: "pane", targetId: "pane-model-tool" },
      startup: { observed: true },
    } as any);
    const tools = new Map<string, any>();
    registerModelToolJourney({ registerTool: (tool) => tools.set(tool.name, tool) }, port);

    await tools.get("ensure_worker").execute(
      "ensure-model-tool-worker",
      { name: "worker", scope: "fixture scope" },
      undefined,
      undefined,
      {
        cwd,
        isProjectTrusted: () => projectTrusted,
        sessionManager: {
          getSessionId: () => leaderSessionId,
          getSessionFile: () => `/tmp/${name}-lead.jsonl`,
        },
      },
    );

    expect(launchBridge.ensureWorker).toHaveBeenCalledOnce();
    const request = launchBridge.ensureWorker.mock.calls[0][0];
    expect(request.cwd).toBe(cwd);
    expect(request.workerAggregate(cwd)).toMatchObject({
      projectTrusted,
      defaultModel: projectTrusted ? { scope: "project", value: "project/model" } : undefined,
    });
  });

  it("does not advance the hidden watermark when event consumption fails", async () => {
    const { name, port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const task = {
      id: "watermark-task",
      title: "Watermark safety",
      description: "Ensure failed event reads do not advance observation state.",
      acceptanceCriteria: "The hidden watermark stays at the last complete observation.",
      status: "open" as const,
      relations: [],
      version: "beads_watermark_v1",
      provenance: { authority: "beads" as const, teamName: name },
    };
    vi.spyOn(authority, "listTaskIds").mockResolvedValue([task.id]);
    vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([{
      task,
      taskMetadata: {
        schema: TASK_METADATA_SCHEMA,
        goal: "Keep the hidden watermark safe.",
        current_context: "No event read has failed yet.",
      },
    }]);

    const snapshot = await port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call");
    expect(snapshot).toMatchObject({ kind: "snapshot", head: 0 });
    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await expect(port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"])).resolves.toBe(true);

    const beforeFailure = await readHiddenObservationProjection(name, {
      teamEpochId: (await teams.readConfig(name)).epochId!,
      exactSessionId: sessionFile,
      branchLineage: ["snapshot-entry"],
    });
    expect(beforeFailure).toMatchObject({ kind: "found", projection: { teamEventCursor: "0" } });

    const readEvents = vi.spyOn(teamEvents, "readTeamEvents").mockImplementation(() => {
      throw new Error("simulated event authority failure");
    });
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "failed-updates"))
      .rejects.toThrow("simulated event authority failure");
    expect(port.getPendingObservation(leaderSessionId)).toBeUndefined();
    readEvents.mockRestore();

    const afterFailure = await readHiddenObservationProjection(name, {
      teamEpochId: (await teams.readConfig(name)).epochId!,
      exactSessionId: sessionFile,
      branchLineage: ["snapshot-entry"],
    });
    expect(afterFailure).toMatchObject({ kind: "found", projection: { teamEventCursor: "0" } });

    await teamEvents.appendTeamEvent(name, {
      type: "worker",
      worker: "worker",
      membershipId: "watermark-membership",
      phase: "failed",
    });
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "recovered-updates"))
      .resolves.toMatchObject({ kind: "updates", head: 1 });
  });

  it("hydrates direct Task reads once for unique requested IDs and restores duplicates", async () => {
    const { name, port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    const task = (id: string) => ({
      id,
      title: `${id} title`,
      description: "Compatibility text",
      acceptanceCriteria: "Compatibility text",
      status: "open" as const,
      relations: [],
      version: `beads_${id}`,
      provenance: { authority: "beads" as const, teamName: name },
    });
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockImplementation(async (_teamName, taskIds) => taskIds.map((taskId) => ({
      task: task(taskId),
      taskMetadata: {
        schema: TASK_METADATA_SCHEMA,
        goal: "Keep the direct Task read usable.",
        current_context: taskId === "invalid-task"
          ? "👩🏽‍🚀".repeat(2_001)
          : "Valid candidate context.",
      },
    })));

    await expect(port.readTasks(leaderSessionId, ["valid-task", "invalid-task", "valid-task"])).resolves.toMatchObject({
      kind: "read",
      tasks: [
        { id: "valid-task", current_context: "Valid candidate context." },
        { id: "invalid-task", projection_warnings: [{ task_id: "invalid-task", truncated_fields: ["current_context"] }] },
        { id: "valid-task", current_context: "Valid candidate context." },
      ],
    });
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledWith(name, ["valid-task", "invalid-task"]);
  });

  it("returns one ordered missing outcome from the same exact-ID hydration", async () => {
    const { name, port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([
      undefined,
      {
        task: {
          id: "existing-task",
          title: "Existing task",
          description: "Compatibility text",
          acceptanceCriteria: "Compatibility text",
          status: "open",
          relations: [],
          version: "beads_existing",
          provenance: { authority: "beads", teamName: name },
        },
        taskMetadata: {
          schema: TASK_METADATA_SCHEMA,
          goal: "Keep missing Task behavior explicit.",
          current_context: "The Task exists.",
        },
      },
    ]);

    await expect(port.readTasks(leaderSessionId, ["missing-task", "existing-task", "missing-task"])).resolves.toMatchObject({
      kind: "read",
      tasks: [undefined, { id: "existing-task", version: taskVersionRef("beads_existing") }, undefined],
    });
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledWith(name, ["missing-task", "existing-task"]);
  });

  it("returns whole-call unavailable when exact-ID hydration fails", async () => {
    const { name, port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockRejectedValue(new Error("simulated authority failure"));

    await expect(port.readTasks(leaderSessionId, ["first-task", "second-task"])).resolves.toEqual({
      kind: "unavailable",
      reason: "task_authority_unavailable",
      message: "simulated authority failure",
    });
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledWith(name, ["first-task", "second-task"]);
  });

  it("publishes an explicit warning for updates after external context exceeds the display limit", async () => {
    const { name, port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    let currentContext = "Valid candidate context.";
    const task = {
      id: "invalid-after-snapshot",
      title: "External context changed",
      description: "Compatibility text",
      acceptanceCriteria: "Compatibility text",
      status: "open" as const,
      relations: [],
      version: "beads_context_changed",
      provenance: { authority: "beads" as const, teamName: name },
    };
    vi.spyOn(authority, "listTaskIds").mockResolvedValue([task.id]);
    vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockImplementation(async () => ([{
      task,
      taskMetadata: {
        schema: TASK_METADATA_SCHEMA,
        goal: "Keep the Team observation coherent.",
        current_context: currentContext,
      },
    }]));

    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await expect(port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "valid-snapshot")).resolves.toMatchObject({ kind: "snapshot" });
    port.setPendingObservationResult(leaderSessionId, { kind: "snapshot" });
    await expect(port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"])).resolves.toBe(true);

    currentContext = "👩🏽‍🚀".repeat(2_001);
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "invalid-updates")).resolves.toMatchObject({
      kind: "updates",
      taskProjectionWarnings: [{ task_id: "invalid-after-snapshot", truncated_fields: ["current_context"] }],
    });
    expect(port.getPendingObservation(leaderSessionId)).toBeDefined();
  });

  it("hydrates event-referenced Tasks once and merges them with the acknowledged baseline", async () => {
    const { name, port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    const record = (id: string) => ({
      task: {
        id,
        title: `${id} title`,
        description: "Compatibility text",
        acceptanceCriteria: "Compatibility text",
        status: "open" as const,
        relations: [],
        version: `beads_${id}`,
        provenance: { authority: "beads" as const, teamName: name },
      },
      taskMetadata: {
        schema: TASK_METADATA_SCHEMA,
        goal: "Keep event hydration complete.",
        current_context: "Current Task context.",
      },
    });
    vi.spyOn(authority, "listTaskIds").mockResolvedValue(["baseline-task"]);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockImplementation(async (_teamName, taskIds) => taskIds.map(record));

    await expect(port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call")).resolves.toMatchObject({
      kind: "snapshot",
      tasks: [{ id: "baseline-task" }],
    });
    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await expect(port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"])).resolves.toBe(true);
    hydrate.mockClear();

    await teamEvents.appendTeamEvent(name, {
      type: "task",
      ref: { taskId: "event-task", version: taskVersionRef("event-v1") },
      change: "status",
      actor: "team-lead",
    });
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "event-update")).resolves.toMatchObject({
      kind: "updates",
      taskChanges: [{ taskId: "event-task", current: { id: "event-task" } }],
    });
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledWith(name, ["event-task"]);
  });

  it("does not hydrate Tasks for a Worker-only event batch", async () => {
    const { name, port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    const record = {
      task: {
        id: "baseline-task",
        title: "Baseline task",
        description: "Compatibility text",
        acceptanceCriteria: "Compatibility text",
        status: "open" as const,
        relations: [],
        version: "beads_baseline-task",
        provenance: { authority: "beads" as const, teamName: name },
      },
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "Keep the baseline.", current_context: "Current context." },
    };
    vi.spyOn(authority, "listTaskIds").mockResolvedValue(["baseline-task"]);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([record]);
    await port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call");
    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"]);
    hydrate.mockClear();

    await teamEvents.appendTeamEvent(name, {
      type: "worker",
      worker: "worker",
      membershipId: "membership-worker",
      phase: "session_bound",
    });
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "worker-update")).resolves.toMatchObject({ kind: "updates", head: 1 });
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("fails event hydration before staging or advancing the hidden observation", async () => {
    const { name, port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    const record = {
      task: {
        id: "baseline-task",
        title: "Baseline task",
        description: "Compatibility text",
        acceptanceCriteria: "Compatibility text",
        status: "open" as const,
        relations: [],
        version: "beads_baseline-task",
        provenance: { authority: "beads" as const, teamName: name },
      },
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "Keep the baseline.", current_context: "Current context." },
    };
    vi.spyOn(authority, "listTaskIds").mockResolvedValue(["baseline-task"]);
    const hydrate = vi.spyOn(authority, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([record]);
    await port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call");
    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"]);
    hydrate.mockImplementation(async () => [undefined]);

    await teamEvents.appendTeamEvent(name, {
      type: "task",
      ref: { taskId: "missing-task", version: taskVersionRef("missing-v1") },
      change: "created",
      actor: "team-lead",
    });
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "failed-update")).rejects.toThrow(/could not be hydrated/);
    expect(port.getPendingObservation(leaderSessionId)).toBeUndefined();
    await expect(readHiddenObservationProjection(name, {
      teamEpochId: (await teams.readConfig(name)).epochId!,
      exactSessionId: `/tmp/${name}-lead.jsonl`,
      branchLineage: ["snapshot-entry"],
    })).resolves.toMatchObject({ kind: "found", projection: { teamEventCursor: "0" } });
  });

  it.each([
    ["foreign version", "another-model-tool-version"],
    ["legacy absent version", undefined],
  ])("fails closed for a %s before any authority call", async (_caseName, implementationVersion) => {
    const { port, leaderSessionId, launchBridge, lifecycle } = await foreignPort(implementationVersion);
    const listTasks = vi.spyOn(authority, "listTaskIds");
    const readTask = vi.spyOn(authority, "readTaskAuthorityRecordEnvelope");
    const updateLink = vi.spyOn(authority, "mutateTaskLink");
    const sendAlert = vi.spyOn(alerts, "sendAlert");
    const readEvents = vi.spyOn(teamEvents, "readTeamEvents");
    const waitEvents = vi.spyOn(teamEvents, "waitForTeamEvents");

    await expect(port.readSnapshot(leaderSessionId)).resolves.toEqual({ kind: "no_active_team" });
    await expect(port.readTasks(leaderSessionId, ["task-1"])).resolves.toEqual({ kind: "no_active_team" });
    await expect(port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "sync-1")).resolves.toMatchObject({
      kind: "unavailable",
      reason: "no_active_team",
    });
    await expect(port.ensureWorker(leaderSessionId, { name: "worker", scope: "fixture scope" })).resolves.toEqual({ kind: "no_active_team" });
    await expect(port.createTask(leaderSessionId, { operationId: "fenced-create", title: "Task", goal: "Keep the fence closed." })).resolves.toEqual({ kind: "no_active_team", operationId: "fenced-create" });
    await expect(port.updateTasks(leaderSessionId, [{
      taskId: "task-1",
      operationId: "operation-1",
      expectedVersion: taskVersionRef("v1"),
      currentContext: "No write is allowed.",
    }])).resolves.toEqual({ kind: "no_active_team" });
    await expect(port.linkTask(leaderSessionId, {
      taskId: "task-1",
      targetId: "task-2",
      relation: "related",
      action: "add",
    })).resolves.toMatchObject({ kind: "unavailable", reason: "no_active_team" });
    await expect(port.sendAlert(leaderSessionId, {
      target: { kind: "worker", name: "worker" },
      kind: "attention",
      text: "No alert is allowed.",
    })).resolves.toMatchObject({ kind: "unavailable", reason: "no_active_team" });
    await expect(port.stopWorker(leaderSessionId, "worker")).resolves.toMatchObject({ kind: "unavailable", reason: "no_active_team" });
    await expect(port.shutdownTeam(leaderSessionId)).resolves.toMatchObject({ kind: "unavailable", reason: "no_active_team" });

    expect(launchBridge.ensureWorker).not.toHaveBeenCalled();
    expect(lifecycle.stopWorker).not.toHaveBeenCalled();
    expect(lifecycle.shutdownTeam).not.toHaveBeenCalled();
    expect(listTasks).not.toHaveBeenCalled();
    expect(readTask).not.toHaveBeenCalled();
    expect(updateLink).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
    expect(readEvents).not.toHaveBeenCalled();
    expect(waitEvents).not.toHaveBeenCalled();
  });

});
