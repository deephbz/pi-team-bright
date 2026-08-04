import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as alerts from "../utils/alerts";
import * as paths from "../utils/paths";
import * as tasks from "../utils/tasks";
import * as teamEvents from "../utils/team-events";
import * as teams from "../utils/teams";
import { DurableModelToolTeamPort, type ModelToolLifecycle } from "./durable-model-tool-port";
import { exactLeaderSessionId } from "./in-memory-team-port";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "./model-tool-constants";
import { CANDIDATE_TASK_METADATA_SCHEMA } from "../utils/beads";
import { readHiddenObservationProjection } from "../utils/hidden-observation";
import { registerModelToolJourney } from "./pi-registration";

const testTeams: string[] = [];

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
  for (const name of testTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
});

describe("DurableModelToolTeamPort implementation fence", () => {
  it("tolerates one externally oversized candidate Task without rejecting the snapshot", async () => {
    const { port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    vi.spyOn(tasks, "listCandidateTaskIds").mockResolvedValue(["invalid-task"]);
    vi.spyOn(tasks, "readCandidateTaskAuthorityRecords").mockResolvedValue([{
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
      candidateMetadata: {
        schema: CANDIDATE_TASK_METADATA_SCHEMA,
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
    vi.spyOn(tasks, "listCandidateTaskIds").mockResolvedValue([task.id]);
    vi.spyOn(tasks, "readCandidateTaskAuthorityRecords").mockResolvedValue([{
      task,
      candidateMetadata: {
        schema: CANDIDATE_TASK_METADATA_SCHEMA,
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

  it("keeps valid direct Task reads usable beside an invalid external Task", async () => {
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
    vi.spyOn(tasks, "readCandidateTaskAuthorityRecord").mockImplementation(async (_teamName, taskId) => ({
      task: task(taskId),
      candidateMetadata: {
        schema: CANDIDATE_TASK_METADATA_SCHEMA,
        goal: "Keep the direct Task read usable.",
        current_context: taskId === "invalid-task"
          ? "👩🏽‍🚀".repeat(2_001)
          : "Valid candidate context.",
      },
    }));

    await expect(port.readTasks(leaderSessionId, ["valid-task", "invalid-task", "valid-task"])).resolves.toMatchObject({
      kind: "read",
      tasks: [
        { id: "valid-task", current_context: "Valid candidate context." },
        { id: "invalid-task", projection_warnings: [{ task_id: "invalid-task", truncated_fields: ["current_context"] }] },
        { id: "valid-task", current_context: "Valid candidate context." },
      ],
    });
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
    vi.spyOn(tasks, "listCandidateTaskIds").mockResolvedValue([task.id]);
    vi.spyOn(tasks, "readCandidateTaskAuthorityRecords").mockImplementation(async () => ([{
      task,
      candidateMetadata: {
        schema: CANDIDATE_TASK_METADATA_SCHEMA,
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

  it.each([
    ["foreign version", "another-model-tool-version"],
    ["legacy absent version", undefined],
  ])("fails closed for a %s before any authority call", async (_caseName, implementationVersion) => {
    const { port, leaderSessionId, launchBridge, lifecycle } = await foreignPort(implementationVersion);
    const listTasks = vi.spyOn(tasks, "listCandidateTaskIds");
    const readTask = vi.spyOn(tasks, "readTask");
    const updateLink = vi.spyOn(tasks, "mutateTaskLink");
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
      expectedVersion: "v1",
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
