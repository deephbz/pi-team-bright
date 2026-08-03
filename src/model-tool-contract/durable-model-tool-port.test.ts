import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as alerts from "../utils/alerts";
import * as paths from "../utils/paths";
import * as tasks from "../utils/tasks";
import * as teamEvents from "../utils/team-events";
import * as teams from "../utils/teams";
import { DurableModelToolTeamPort, type ModelToolLifecycle } from "./durable-model-tool-port";
import { exactLeaderSessionId } from "./in-memory-team-port";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "./model-tool-constants";
import { CANDIDATE_TASK_METADATA_SCHEMA } from "../utils/beads";

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
  it("fails closed on one externally oversized candidate Task without staging a partial snapshot", async () => {
    const { port, leaderSessionId } = await foreignPort(MODEL_TOOL_IMPLEMENTATION_VERSION);
    vi.spyOn(tasks, "listTasksWithVersions").mockResolvedValue([{
      id: "invalid-task",
      title: "Invalid external context",
      description: "Compatibility text",
      acceptanceCriteria: "Compatibility text",
      status: "open",
      relations: [],
      version: "beads_invalid_task",
      provenance: { authority: "beads", teamName: testTeams[testTeams.length - 1] },
    }]);
    vi.spyOn(tasks, "readCandidateTaskAuthorityRecord").mockResolvedValue({
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
    });

    await expect(port.readSnapshot(leaderSessionId)).resolves.toMatchObject({
      kind: "contract_gap",
      reason: "candidate_metadata_invalid",
    });
    await expect(port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "invalid-snapshot")).resolves.toMatchObject({
      kind: "contract_gap",
      reason: "candidate_metadata_invalid",
    });
    expect(port.getPendingObservation(leaderSessionId)).toBeUndefined();
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
          ? "👩🏽‍🚀".repeat(1_001)
          : "Valid candidate context.",
      },
    }));

    await expect(port.readTasks(leaderSessionId, ["valid-task", "invalid-task", "valid-task"])).resolves.toMatchObject({
      kind: "read",
      tasks: [
        { id: "valid-task", current_context: "Valid candidate context." },
        { kind: "contract_gap", reason: "candidate_metadata_invalid", taskId: "invalid-task" },
        { id: "valid-task", current_context: "Valid candidate context." },
      ],
    });
  });

  it("returns a no-observation gap for updates after external context becomes invalid", async () => {
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
    vi.spyOn(tasks, "listTasksWithVersions").mockResolvedValue([task]);
    vi.spyOn(tasks, "readCandidateTaskAuthorityRecord").mockImplementation(async () => ({
      task,
      candidateMetadata: {
        schema: CANDIDATE_TASK_METADATA_SCHEMA,
        goal: "Keep the Team observation coherent.",
        current_context: currentContext,
      },
    }));

    port.setBranchContext(leaderSessionId, ["snapshot-entry"]);
    await expect(port.readTeamSync(leaderSessionId, "snapshot", new AbortController().signal, "valid-snapshot")).resolves.toMatchObject({ kind: "snapshot" });
    port.setPendingObservationResult(leaderSessionId, { kind: "snapshot" });
    await expect(port.acknowledgePendingObservationAsync(leaderSessionId, "snapshot-entry", ["snapshot-entry"])).resolves.toBe(true);

    currentContext = "👩🏽‍🚀".repeat(2_001);
    await expect(port.readTeamSync(leaderSessionId, "updates", new AbortController().signal, "invalid-updates")).resolves.toMatchObject({
      kind: "contract_gap",
      reason: "candidate_metadata_invalid",
    });
    expect(port.getPendingObservation(leaderSessionId)).toBeUndefined();
  });

  it.each([
    ["foreign version", "another-model-tool-version"],
    ["legacy absent version", undefined],
  ])("fails closed for a %s before any authority call", async (_caseName, implementationVersion) => {
    const { port, leaderSessionId, launchBridge, lifecycle } = await foreignPort(implementationVersion);
    const listTasks = vi.spyOn(tasks, "listTasksWithVersions");
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
