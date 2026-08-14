import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as paths from "../utils/paths";
import { DurableTaskAuthorityProvisioning } from "../adapters/durable-task-authority-provisioning";
import { createReadOnlyBeadsTaskAdapterFactory, projectNonterminalTaskIds, projectTaskChanges } from "./beads-task-adapter";
import { createDurableCoordinationQueries } from "../adapters/durable-coordination-queries";
import * as teamEvents from "../coordination/event-journal";
import type { TeamEventInput } from "../coordination/contracts";
import * as teams from "../utils/teams";
import { DurableModelToolTeamPort, type ModelToolLifecycle } from "./durable-model-tool-port";
import { exactLeaderSessionId } from "./in-memory-team-port";
import { TASK_METADATA_SCHEMA } from "../utils/beads";
import { readHiddenObservationProjection } from "../utils/hidden-observation";
import { registerModelToolJourney } from "./pi-registration";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import { taskVersionRef } from "./task-version-ref";
import { DEFAULT_SYNC_NUDGE_DELAY_SECONDS } from "../utils/sync-liveness-settings";
import { taskProjectionRevision } from "../coordination/task-projection-revision";
import { CoordinationObservationService, createDurableCoordinationObservationStore } from "../coordination/observation-service";
import { createDurableCoordinationNudgeStore } from "../adapters/durable-coordination-nudge-store";
import { DurableCoordinationHiddenObservation } from "../adapters/durable-coordination-hidden-observation";

const testTeams: string[] = [];
const paneSettingsRoots: string[] = [];
const readPort = {
  readTaskAuthorityRecordEnvelope: vi.fn(),
  readTaskAuthorityRecordEnvelopes: vi.fn(),
  listTaskIds: vi.fn(),
};
const readFactory = createReadOnlyBeadsTaskAdapterFactory(readPort);

function composedPort(
  launchBridge: any = undefined,
  lifecycle: ModelToolLifecycle | undefined = undefined,
  factory = readFactory,
  alertSender: any = undefined,
  queries = createDurableCoordinationQueries(factory),
) {
  const hidden = new DurableCoordinationHiddenObservation();
  return new DurableModelToolTeamPort(
    launchBridge,
    lifecycle,
    factory,
    alertSender,
    new CoordinationObservationService(queries, { projectNonterminalTaskIds, projectTaskChanges }, createDurableCoordinationObservationStore(hidden), undefined, createDurableCoordinationNudgeStore(hidden)),
    new DurableTaskAuthorityProvisioning(),
  );
}

function teamName(suffix: string): string {
  const name = `durable-model-tool-fence-${suffix}-${process.pid}-${Date.now()}-${testTeams.length}`;
  testTeams.push(name);
  return name;
}

/** Prepare a valid event page without making this hydration test contend on 51 fsync-backed appends. */
function stageEventPage(name: string, inputs: readonly TeamEventInput[]): void {
  const journal = paths.teamEventJournalPath(name);
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(journal, `${inputs.map((input, index) => JSON.stringify({ ...input, cursor: String(index + 1), at: "2026-08-11T00:00:00.000Z" })).join("\n")}\n`, { mode: 0o600 });
}

async function teamFixture(implementationVersion: string | undefined) {
  const name = teamName(implementationVersion ? "historical-provenance" : "no-provenance");
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
  const port = composedPort(launchBridge, lifecycle);
  const leaderSessionId = exactLeaderSessionId(`session-${name}`);
  port.setLeaderSessionFile(leaderSessionId, sessionFile);
  return { name, port, leaderSessionId, launchBridge, lifecycle };
}

afterEach(() => {
  vi.restoreAllMocks();
  readPort.readTaskAuthorityRecordEnvelope.mockReset();
  readPort.readTaskAuthorityRecordEnvelopes.mockReset();
  readPort.listTaskIds.mockReset();
  clearAdapterCache();
  for (const name of testTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
  for (const root of paneSettingsRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function createTeamWithPaneSettings(projectTrusted?: boolean, globalTeamSettings?: Record<string, unknown>): Promise<{ result: any; createArgs: any[] }> {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "pi-team-pane-settings-"));
  paneSettingsRoots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "leader-project");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    ...(globalTeamSettings ? { pi_team_bright: { team: globalTeamSettings } } : {}),
  }));
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
  vi.spyOn(DurableTaskAuthorityProvisioning.prototype, "resolve").mockResolvedValue({
    workspace: path.join(root, "tasks"), authorityId: "authority-pane-settings", fingerprint: {} as any,
  });
  let createArgs: any[] | undefined;
  vi.spyOn(teams, "createTeam").mockImplementation(async (...args: any[]) => {
    createArgs = args;
    return { name: args[0], description: args[3], members: [] } as any;
  });
  const port = composedPort({ ensureWorker: vi.fn() });
  const leaderSessionId = exactLeaderSessionId(`pane-settings-${Date.now()}-${Math.random()}`);
  port.setLeaderSessionFile(leaderSessionId, path.join(root, "leader.jsonl"));
  port.setLeaderLaunchContext(leaderSessionId, { cwd, projectTrusted });
  const result = await port.createTeam(leaderSessionId, { name: `pane-settings-${Date.now()}`, purpose: "Test pane settings." });
  if (!createArgs) throw new Error("Team creation was not invoked.");
  return { result, createArgs };
}

async function lifecycleCreateFixture(lifecycle: ModelToolLifecycle) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "pi-team-lifecycle-callback-"));
  paneSettingsRoots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "leader-project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
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
  const name = teamName("lifecycle-callback");
  vi.spyOn(teams, "resolveCurrentLeadSessionBinding").mockResolvedValue({ status: "abstain", reason: "not_bound" });
  vi.spyOn(DurableTaskAuthorityProvisioning.prototype, "resolve").mockResolvedValue({
    workspace: path.join(root, "tasks"),
    authorityId: "authority-lifecycle-callback",
    fingerprint: { schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: name, projectId: name },
  });
  const sessionFile = path.join(root, "leader.jsonl");
  const leaderSessionId = exactLeaderSessionId(`lifecycle-callback-${Date.now()}-${Math.random()}`);
  const port = composedPort({ ensureWorker: vi.fn() }, lifecycle);
  port.setLeaderSessionFile(leaderSessionId, sessionFile);
  port.setLeaderLaunchContext(leaderSessionId, { cwd, projectTrusted: true });
  return { name, port, leaderSessionId, sessionFile };
}

describe("DurableModelToolTeamPort sync liveness policy", () => {
  it("persists resolved nudge defaults when a new Team epoch is created", async () => {
    const { result, createArgs } = await createTeamWithPaneSettings(undefined, {});
    expect(result).toMatchObject({ kind: "created" });
    expect(createArgs[11]).toBeUndefined();
    expect(createArgs[13]).toMatchObject({ waitSeconds: 120, nudgeEnabled: true, nudgeDelaySeconds: DEFAULT_SYNC_NUDGE_DELAY_SECONDS });
  });

  it("falls back to nudge defaults for malformed settings and preserves explicit disable", async () => {
    const malformed = await createTeamWithPaneSettings(undefined, { nudge_enabled: "yes", nudge_delay_seconds: -1 });
    expect(malformed.createArgs[13]).toMatchObject({ nudgeEnabled: true, nudgeDelaySeconds: DEFAULT_SYNC_NUDGE_DELAY_SECONDS });
    const disabled = await createTeamWithPaneSettings(undefined, { nudge_enabled: false });
    expect(disabled.createArgs[13]).toMatchObject({ nudgeEnabled: false, nudgeDelaySeconds: DEFAULT_SYNC_NUDGE_DELAY_SECONDS });
  });
});

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

describe("DurableModelToolTeamPort lifecycle callback", () => {
  it("creates durably before the callback and returns only after it completes", async () => {
    let enterCallback!: () => void;
    let releaseCallback!: () => void;
    const entered = new Promise<void>((resolve) => { enterCallback = resolve; });
    const released = new Promise<void>((resolve) => { releaseCallback = resolve; });
    const lifecycle: ModelToolLifecycle = {
      teamCreated: vi.fn(async () => {
        enterCallback();
        await released;
      }),
      stopWorker: vi.fn(),
      shutdownTeam: vi.fn(),
    };
    const { name, port, leaderSessionId, sessionFile } = await lifecycleCreateFixture(lifecycle);
    let settled = false;
    const result = port.createTeam(leaderSessionId, { name, purpose: "Characterize callback order." }).then((value) => {
      settled = true;
      return value;
    });

    await entered;
    expect(teams.teamExists(name)).toBe(true);
    expect(await teams.readConfig(name)).toMatchObject({ name, members: [{ name: "team-lead", sessionFile }] });
    expect(settled).toBe(false);
    releaseCallback();

    await expect(result).resolves.toMatchObject({ kind: "created", team: { name } });
    expect(lifecycle.teamCreated).toHaveBeenCalledWith(name, sessionFile);
  });

  it("maps callback rejection while retaining the already-created Team", async () => {
    const lifecycle: ModelToolLifecycle = {
      teamCreated: vi.fn(async () => { throw new Error("callback publication failed"); }),
      stopWorker: vi.fn(),
      shutdownTeam: vi.fn(),
    };
    const { name, port, leaderSessionId, sessionFile } = await lifecycleCreateFixture(lifecycle);

    await expect(port.createTeam(leaderSessionId, { name, purpose: "Characterize callback rejection." })).resolves.toEqual({
      kind: "unavailable",
      reason: "team_authority_unavailable",
      message: "callback publication failed",
    });
    expect(teams.teamExists(name)).toBe(true);
    expect(await teams.readConfig(name)).toMatchObject({ name, members: [{ name: "team-lead", sessionFile }] });
  });
});

describe("DurableModelToolTeamPort durable authority", () => {
  it("tolerates one externally oversized Task without rejecting the snapshot", async () => {
    const { port, leaderSessionId } = await teamFixture(undefined);
    readPort.listTaskIds.mockResolvedValue(["invalid-task"]);
    readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([{
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

  it("returns typed unavailable for snapshot Task authority failure without staging", async () => {
    const { port, leaderSessionId } = await teamFixture(undefined);
    readPort.listTaskIds.mockRejectedValue(new Error("bd list timed out"));

    await expect(port.readSnapshot(leaderSessionId)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "task_authority_unavailable",
      message: "bd list timed out",
    });
    await expect(port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "failed-snapshot")).resolves.toMatchObject({
      kind: "unavailable",
      reason: "task_authority_unavailable",
    });
    expect(port.getPendingObservation(leaderSessionId)).toBeUndefined();
  });

  it("keeps read-only snapshot and nudge-debt use available without a launch bridge", async () => {
    const { name, leaderSessionId } = await teamFixture(undefined);
    const config = await teams.readConfig(name);
    config.syncLiveness = { waitSeconds: 120, nudgeEnabled: true, nudgeDelaySeconds: DEFAULT_SYNC_NUDGE_DELAY_SECONDS, policyVersion: "1" };
    teams.writeConfigAtomic(paths.configPath(name), config);
    readPort.listTaskIds.mockResolvedValue([]);
    readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([]);
    const port = composedPort();
    port.setLeaderSessionFile(leaderSessionId, `/tmp/${name}-lead.jsonl`);

    await expect(port.readSnapshot(leaderSessionId)).resolves.toMatchObject({ kind: "snapshot", team: { name }, tasks: [] });
    await expect(port.readSyncNudgeDebt(leaderSessionId, ["read-only-branch"])).resolves.toMatchObject({
      kind: "eligible",
      requestedView: "snapshot",
      teamEpochId: config.epochId,
    });
  });

  it("keeps legacy nudge policyVersion eligible, but preserves strict logical-Worker absence", async () => {
    const { name, port, leaderSessionId } = await teamFixture(undefined);
    const config: any = await teams.readConfig(name);
    const lead = config.members.find((member: any) => member.name === "team-lead");
    config.syncLiveness = { waitSeconds: 120, nudgeEnabled: true, nudgeDelaySeconds: 5, policyVersion: "current" };
    const { policyVersion: _policyVersion, ...legacyPolicy } = config.syncLiveness;
    config.syncLiveness = legacyPolicy;
    teams.writeConfigAtomic(paths.configPath(name), config);
    readPort.listTaskIds.mockResolvedValue([]);
    readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([]);

    const debt = await port.readSyncNudgeDebt(leaderSessionId, ["legacy-branch"]);
    expect(debt).toEqual(expect.objectContaining({
      kind: "eligible",
      requestedView: "snapshot",
      policyVersion: undefined,
      debtKey: `${config.epochId}|${config.leadSessionId}|${lead.membershipId}|["legacy-branch"]|snapshot|0|${taskProjectionRevision([])}|undefined`,
    }));

    delete config.logicalWorkers;
    teams.writeConfigAtomic(paths.configPath(name), config);
    await expect(port.readSyncNudgeDebt(leaderSessionId, ["legacy-branch"])).resolves.toEqual({
      kind: "unavailable",
      message: "Model-tool logical workers missing is unavailable.",
    });
    await expect(port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "legacy-no-workers-snapshot")).resolves.toEqual({
      kind: "unavailable",
      reason: "no_active_team",
      message: "The exact leader Session is not bound to an active Team.",
    });
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "legacy-no-workers-updates")).resolves.toEqual({
      kind: "unavailable",
      reason: "no_active_team",
      message: "The exact leader Session is not bound to an active Team.",
    });
  });

  it("refuses Worker launch without a bridge before logical Worker mutation", async () => {
    const { name, leaderSessionId } = await teamFixture(undefined);
    const port = composedPort();
    port.setLeaderSessionFile(leaderSessionId, `/tmp/${name}-lead.jsonl`);
    const ensureLogicalWorker = vi.spyOn(teams, "ensureLogicalWorker");

    await expect(port.ensureWorker(leaderSessionId, { name: "worker", scope: "fixture scope" })).resolves.toEqual({
      kind: "unavailable",
      reason: "carrier_unavailable",
      message: "The model-tool Worker launch bridge is not attached to this port.",
    });
    expect(ensureLogicalWorker).not.toHaveBeenCalled();
  });

  it("keeps the durable façade free of concrete Worker-launch construction", () => {
    const source = fs.readFileSync(path.join(__dirname, "durable-model-tool-port.ts"), "utf8");

    expect(source).not.toMatch(/DurableTeamLifecyclePublication|createWorkerLaunchBridge/);
    expect(source).not.toMatch(/beads-authority-adapter|durable-task-authority-provisioning/);
    expect(source).toContain('import type { TaskAuthorityProvisioningPort } from "../task-authority/contracts"');
  });

  it("keeps Task ready reconciliation outside the model-tool Worker topology path", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../extensions/index.ts"), "utf8");
    const teamApplication = fs.readFileSync(path.join(__dirname, "durable-model-tool-team-application.ts"), "utf8");

    expect(source.match(/const workerLaunchBridge = createWorkerLaunchBridge\(/g)).toHaveLength(1);
    expect(source.match(/const alertMembership = new DurableAlertMembership\(\)/g)).toHaveLength(1);
    expect(source.match(/const alertPublication = new DurableAlertPublication\(\)/g)).toHaveLength(1);
    expect(source).toContain("const alertSender = createAlertSender(alertMembership, alertPublication)");
    expect(source.match(/const coordinationQueries = createDurableCoordinationQueries\(taskReadAdapterFactory, graphTaskOrchestration\)/g)).toHaveLength(1);
    expect(source).toContain("const modelToolBindings = new DurableModelToolBindings()");
    expect(source).toContain("const taskAuthorityProvisioning = new DurableTaskAuthorityProvisioning()");
    expect(source).toContain("new DurableModelToolTeamApplication(modelToolBindings, workerLaunchBridge, lifecycle, taskAuthorityProvisioning)");
    expect(source).not.toContain("new DurableModelToolTeamApplication(modelToolBindings, workerLaunchBridge, lifecycle, taskAuthorityProvisioning, taskOrchestration)");
    expect(teamApplication).not.toContain("taskOrchestration");
    expect(teamApplication).not.toContain("reconcileReady(");
    expect(source).toContain("new DurableModelToolTaskApplication(modelToolBindings, taskAdapterFactory, taskOrchestration, graphTaskOrchestration)");
    expect(source).toContain("new DurableModelToolAlertApplication(modelToolBindings, alertSender)");
    expect(source).toContain("new DurableModelToolCoordinationApplication(modelToolBindings, coordinationObservationService)");
  });

  it.each([true, false])("propagates leader cwd and explicit trust through model-tool registration (%s)", async (projectTrusted) => {
    const { name, port, leaderSessionId, launchBridge } = await teamFixture(undefined);
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

    const result = await tools.get("ensure_worker").execute(
      "ensure-model-tool-worker",
      { name: "worker", scope: "fixture scope" },
      undefined,
      undefined,
      {
        cwd,
        isProjectTrusted: () => projectTrusted,
        modelRegistry: {
          getAvailable: () => [
            { provider: "fixture", id: "selected" },
            { provider: "fixture", id: "not-in-result" },
          ],
        },
        sessionManager: {
          getSessionId: () => leaderSessionId,
          getSessionFile: () => `/tmp/${name}-lead.jsonl`,
        },
      },
    );

    expect(launchBridge.ensureWorker).toHaveBeenCalledOnce();
    const request = launchBridge.ensureWorker.mock.calls[0][0];
    expect(request).toMatchObject({
      teamName: name,
      workerName: "worker",
      scope: "fixture scope",
      cwd,
      workerAggregate: expect.any(Function),
      launchEnvironment: { PI_TEAM_BRIGHT_MODEL_TOOL: "1" },
    });
    expect(request.availableModelKeys).toEqual(new Set(["fixture/selected", "fixture/not-in-result"]));
    expect(JSON.stringify(result.details)).not.toContain("fixture/not-in-result");
    expect(JSON.stringify(result.content)).not.toContain("fixture/not-in-result");
    expect(request.workerAggregate(cwd)).toMatchObject({
      projectTrusted,
      defaultModel: projectTrusted ? { scope: "project", value: "project/model" } : undefined,
    });
  });

  it("does not advance the hidden watermark when event consumption fails", async () => {
    const { name, port, leaderSessionId } = await teamFixture(undefined);
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
    readPort.listTaskIds.mockResolvedValue([task.id]);
    readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([{
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
    const { name, port, leaderSessionId } = await teamFixture(undefined);
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
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockImplementation(async (_teamName: string, taskIds: readonly string[]) => taskIds.map((taskId) => ({
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
    const { name, port, leaderSessionId } = await teamFixture(undefined);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([
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
    const { name, port, leaderSessionId } = await teamFixture(undefined);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockRejectedValue(new Error("simulated authority failure"));

    await expect(port.readTasks(leaderSessionId, ["first-task", "second-task"])).resolves.toEqual({
      kind: "unavailable",
      reason: "task_authority_unavailable",
      message: "simulated authority failure",
    });
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledWith(name, ["first-task", "second-task"]);
  });

  it("publishes an explicit warning for updates after external context exceeds the display limit", async () => {
    const { name, port, leaderSessionId } = await teamFixture(undefined);
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
    readPort.listTaskIds.mockResolvedValue([task.id]);
    readPort.readTaskAuthorityRecordEnvelopes.mockImplementation(async () => ([{
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

  it("acknowledges only the returned event page cursor", async () => {
    const { name, port, leaderSessionId } = await teamFixture(undefined);
    readPort.listTaskIds.mockResolvedValue([]);
    readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([]);
    const config = await teams.readConfig(name);
    config.logicalWorkers = [{ name: "worker", scope: "page test" }];
    teams.writeConfigAtomic(paths.configPath(name), config);
    await port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call");
    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"]);
    for (let index = 0; index < 60; index++) {
      await teamEvents.appendTeamEvent(name, {
        type: "worker",
        worker: "worker",
        membershipId: `membership-${index}`,
        phase: "failed",
      });
    }

    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "page-one")).resolves.toMatchObject({
      kind: "updates",
      head: 50,
      workerChanges: { length: 50 },
    });
    expect(await readHiddenObservationProjection(name, {
      teamEpochId: (await teams.readConfig(name)).epochId!,
      exactSessionId: `/tmp/${name}-lead.jsonl`,
      branchLineage: ["snapshot-entry"],
    })).toMatchObject({ kind: "found", projection: { teamEventCursor: "0" } });
    port.setBranchContext(leaderSessionId, ["snapshot-entry", "page-one-entry"]);
    await expect(port.acknowledgePendingObservationAsync(leaderSessionId, "page-one-entry", ["snapshot-entry", "page-one-entry"])).resolves.toBe(true);
    expect(await readHiddenObservationProjection(name, {
      teamEpochId: (await teams.readConfig(name)).epochId!,
      exactSessionId: `/tmp/${name}-lead.jsonl`,
      branchLineage: ["snapshot-entry", "page-one-entry"],
    })).toMatchObject({ kind: "found", projection: { teamEventCursor: "50" } });

    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "page-two")).resolves.toMatchObject({
      kind: "updates",
      head: 60,
      workerChanges: { length: 10 },
    });
  });

  it("does not advance a paged watermark when page hydration fails", async () => {
    const { name, port, leaderSessionId } = await teamFixture(undefined);
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
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "Keep page failure safe.", current_context: "Current context." },
    };
    readPort.listTaskIds.mockResolvedValue(["baseline-task"]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([record]);
    await port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call");
    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"]);
    hydrate.mockResolvedValue([undefined]);
    stageEventPage(name, [
      {
        type: "task",
        ref: { taskId: "missing-page-task", version: taskVersionRef("missing-page-v1") },
        change: "created",
        actor: "team-lead",
      },
      ...Array.from({ length: 50 }, (_, index) => ({
        type: "worker" as const,
        worker: "worker",
        membershipId: `membership-${index}`,
        phase: "failed" as const,
      })),
    ]);
    const stagedPage = teamEvents.readTeamEvents(name, { limit: 50 });
    expect(stagedPage).toMatchObject({ cursor: "50", headCursor: "51", truncated: true });
    expect(stagedPage.events[0]).toMatchObject({ type: "task", ref: { taskId: "missing-page-task" } });

    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "failed-page")).resolves.toMatchObject({
      kind: "unavailable",
      reason: "task_authority_unavailable",
    });
    expect(port.getPendingObservation(leaderSessionId)).toBeUndefined();
    await expect(readHiddenObservationProjection(name, {
      teamEpochId: (await teams.readConfig(name)).epochId!,
      exactSessionId: `/tmp/${name}-lead.jsonl`,
      branchLineage: ["snapshot-entry"],
    })).resolves.toMatchObject({ kind: "found", projection: { teamEventCursor: "0" } });
  });

  it("recovers a complete baseline after a port restart before applying event references", async () => {
    const { name, leaderSessionId, port } = await teamFixture(undefined);
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    const record = (id: string, version: string) => ({
      task: {
        id,
        title: `${id} title`,
        description: "Compatibility text",
        acceptanceCriteria: "Compatibility text",
        status: "open" as const,
        relations: [],
        version,
        provenance: { authority: "beads" as const, teamName: name },
      },
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "Keep restart recovery safe.", current_context: "Current context." },
    });
    const records = new Map([
      ["baseline-task", record("baseline-task", "baseline-v1")],
      ["event-task", record("event-task", "event-v1")],
    ]);
    readPort.listTaskIds.mockResolvedValue(["baseline-task"]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockImplementation(async (_teamName: string, taskIds: readonly string[]) => taskIds.map((id) => records.get(id)));
    await port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call");
    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"]);

    await teamEvents.appendTeamEvent(name, {
      type: "task",
      ref: { taskId: "event-task", version: taskVersionRef("event-v1") },
      change: "status",
      actor: "team-lead",
    });
    readPort.listTaskIds.mockResolvedValue(["baseline-task", "event-task"]);
    const resumed = composedPort({ ensureWorker: vi.fn() });
    resumed.setLeaderSessionFile(leaderSessionId, sessionFile);
    resumed.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await expect(resumed.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "restart-update")).resolves.toMatchObject({
      kind: "updates",
      taskChanges: [{ taskId: "event-task", current: { id: "event-task" } }],
    });
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenLastCalledWith(name, ["baseline-task", "event-task"]);
  });

  it("requires a fresh snapshot after a branch switch instead of using another branch baseline", async () => {
    const { name, port, leaderSessionId } = await teamFixture(undefined);
    const record = {
      task: {
        id: "branch-task",
        title: "Branch task",
        description: "Compatibility text",
        acceptanceCriteria: "Compatibility text",
        status: "open" as const,
        relations: [],
        version: "branch-v1",
        provenance: { authority: "beads" as const, teamName: name },
      },
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "Keep branches separate.", current_context: "Current context." },
    };
    readPort.listTaskIds.mockResolvedValue(["branch-task"]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([record]);
    await port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call");
    port.setBranchContext(leaderSessionId, ["branch-a"]);
    await port.acknowledgePendingObservationAsync(leaderSessionId, "branch-a", ["branch-a"]);
    hydrate.mockClear();

    port.setBranchContext(leaderSessionId, ["branch-b"]);
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "wrong-branch-update")).resolves.toEqual({
      kind: "snapshot_required",
      message: "Take a Team snapshot before requesting updates.",
    });
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("rechecks complete Task authority after a quiet wait wakes", async () => {
    const { name, port, leaderSessionId } = await teamFixture(undefined);
    let version = "quiet-v1";
    const record = () => ({
      task: {
        id: "quiet-task",
        title: "Quiet task",
        description: "Compatibility text",
        acceptanceCriteria: "Compatibility text",
        status: "open" as const,
        relations: [],
        version,
        provenance: { authority: "beads" as const, teamName: name },
      },
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "Keep eventless changes.", current_context: "Current context." },
    });
    readPort.listTaskIds.mockResolvedValue(["quiet-task"]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockImplementation(async () => [record()]);
    await port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call");
    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"]);

    vi.spyOn(teamEvents, "waitForTeamEvents").mockImplementation(async () => {
      version = "quiet-v2";
      const event = await teamEvents.appendTeamEvent(name, {
        type: "worker",
        worker: "worker",
        membershipId: "membership-worker",
        phase: "failed",
      });
      return {
        cursor: event.cursor,
        headCursor: event.cursor,
        events: [event],
        truncated: false,
        remaining: 0,
        timedOut: false,
      };
    });
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "quiet-update")).resolves.toMatchObject({
      kind: "updates",
      head: 1,
      taskChanges: [{ taskId: "quiet-task", changeKinds: ["progress"], current: { version: taskVersionRef("quiet-v2") } }],
    });
    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(hydrate).toHaveBeenLastCalledWith(name, ["quiet-task"]);
  });

  it("hydrates event-referenced Tasks once and merges them with the acknowledged baseline", async () => {
    const { name, port, leaderSessionId } = await teamFixture(undefined);
    const record = (id: string) => ({
      task: {
        id,
        title: `${id} title`,
        description: "Compatibility text",
        acceptanceCriteria: "Compatibility text",
        status: "open" as const,
        relations: [],
        version: id === "event-task" ? "event-v1" : `beads_${id}`,
        provenance: { authority: "beads" as const, teamName: name },
      },
      taskMetadata: {
        schema: TASK_METADATA_SCHEMA,
        goal: "Keep event hydration complete.",
        current_context: "Current Task context.",
      },
    });
    readPort.listTaskIds.mockResolvedValue(["baseline-task"]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockImplementation(async (_teamName: string, taskIds: readonly string[]) => taskIds.map(record));

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
    const { name, port, leaderSessionId } = await teamFixture(undefined);
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
    readPort.listTaskIds.mockResolvedValue(["baseline-task"]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([record]);
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

  it.each([
    ["short", "short"],
    ["extra", "extra"],
    ["misaligned", "misaligned"],
    ["contract gap", "contract-gap"],
  ] as const)("rejects a %s canonical Task batch and retries recovery", async (_label, shape) => {
    const { name, port, leaderSessionId } = await teamFixture(undefined);
    const record = (id: string) => ({
      task: {
        id,
        title: `${id} title`,
        description: "Compatibility text",
        acceptanceCriteria: "Compatibility text",
        status: "open" as const,
        relations: [],
        version: id === "event-task" ? "event-v1" : `beads_${id}`,
        provenance: { authority: "beads" as const, teamName: name },
      },
      taskMetadata: { schema: TASK_METADATA_SCHEMA, goal: "Require complete batches.", current_context: "Current context." },
    });
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([record("baseline-task")]);
    readPort.listTaskIds.mockResolvedValue(["baseline-task"]);
    await port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "snapshot-call");
    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"]);

    await teamEvents.appendTeamEvent(name, {
      type: "task",
      ref: { taskId: "event-task", version: taskVersionRef("event-v1") },
      change: "status",
      actor: "team-lead",
    });
    hydrate.mockResolvedValue(shape === "short"
      ? []
      : shape === "extra"
        ? [record("event-task"), record("extra-task")]
        : shape === "misaligned"
          ? [record("other-task")]
          : [{ ...record("event-task"), taskMetadata: { schema: "invalid" } }] as any);
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, `${shape}-failure`)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "task_authority_unavailable",
    });
    expect(port.getPendingObservation(leaderSessionId)).toBeUndefined();

    hydrate.mockResolvedValue([record("event-task")]);
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, `${shape}-recovery`)).resolves.toMatchObject({
      kind: "updates",
      taskChanges: [{ taskId: "event-task", current: { id: "event-task" } }],
    });
    expect(hydrate).toHaveBeenCalledTimes(3);
  });

  it("fails event hydration before staging or advancing the hidden observation", async () => {
    const { name, port, leaderSessionId } = await teamFixture(undefined);
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
    readPort.listTaskIds.mockResolvedValue(["baseline-task"]);
    const hydrate = readPort.readTaskAuthorityRecordEnvelopes.mockResolvedValue([record]);
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
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "failed-update")).resolves.toMatchObject({
      kind: "unavailable",
      reason: "task_authority_unavailable",
      message: expect.stringContaining("could not be hydrated"),
    });
    expect(port.getPendingObservation(leaderSessionId)).toBeUndefined();
    await expect(readHiddenObservationProjection(name, {
      teamEpochId: (await teams.readConfig(name)).epochId!,
      exactSessionId: `/tmp/${name}-lead.jsonl`,
      branchLineage: ["snapshot-entry"],
    })).resolves.toMatchObject({ kind: "found", projection: { teamEventCursor: "0" } });
  });

  it("requires an injected lifecycle for Worker stop and Team shutdown", async () => {
    const { name, leaderSessionId } = await teamFixture(undefined);
    const port = composedPort({ ensureWorker: vi.fn() });
    port.setLeaderSessionFile(leaderSessionId, `/tmp/${name}-lead.jsonl`);

    await expect(port.stopWorker(leaderSessionId, "worker")).resolves.toEqual({
      kind: "unavailable",
      reason: "carrier_unavailable",
      message: "The model-tool lifecycle adapter is not attached to the main extension.",
    });
    await expect(port.shutdownTeam(leaderSessionId)).resolves.toEqual({
      kind: "unavailable",
      reason: "team_authority_unavailable",
      message: "The model-tool lifecycle adapter is not attached to the main extension.",
    });
  });

  it.each([
    ["historical package value", "0.17.0-rc.3"],
    ["absent package value", undefined],
  ])("does not use a %s as a compatibility gate", async (_caseName, implementationVersion) => {
    const { name, port, leaderSessionId, lifecycle } = await teamFixture(implementationVersion);
    vi.mocked(lifecycle.stopWorker).mockResolvedValue({ kind: "stopped", worker: "worker" });
    vi.mocked(lifecycle.shutdownTeam).mockResolvedValue({ kind: "shutdown", stoppedWorkers: ["worker"], unfinishedTaskIds: [] });

    await expect(port.stopWorker(leaderSessionId, "worker")).resolves.toEqual({ kind: "stopped", worker: "worker" });
    await expect(port.shutdownTeam(leaderSessionId)).resolves.toEqual({ kind: "shutdown", stoppedWorkers: ["worker"], unfinishedTaskIds: [] });
    expect(lifecycle.stopWorker).toHaveBeenCalledWith(name, "worker");
    expect(lifecycle.shutdownTeam).toHaveBeenCalledWith(name);
  });

});

describe("durable Trio import fences", () => {
  it("keeps authority implementations in separate modules and keeps named composition off the legacy facade", () => {
    const root = __dirname;
    const sources = {
      team: fs.readFileSync(path.join(root, "durable-model-tool-team-application.ts"), "utf8"),
      task: fs.readFileSync(path.join(root, "durable-model-tool-task-application.ts"), "utf8"),
      alert: fs.readFileSync(path.join(root, "durable-model-tool-alert-application.ts"), "utf8"),
      coordination: fs.readFileSync(path.join(root, "durable-model-tool-coordination-application.ts"), "utf8"),
      extension: fs.readFileSync(path.join(root, "../../extensions/index.ts"), "utf8"),
    };
    expect(fs.existsSync(path.join(root, "durable-model-tool-applications.ts"))).toBe(false);
    expect(sources.team).not.toContain('"./beads-authority-adapter"');
    expect(sources.task).not.toContain('"../alert-authority/');
    expect(sources.alert).not.toContain('"./beads-task-adapter"');
    expect(sources.coordination).not.toContain('"../alert-authority/');
    expect(sources.extension).not.toContain("new DurableModelToolTeamPort(");
  });
});
