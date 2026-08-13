import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { captureTrioProjection, type RegisteredToolLike } from "../../test/support/external-harness";
import { DurableTaskAuthorityRead } from "../adapters/durable-task-authority-read";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import { TASK_METADATA_SCHEMA } from "./beads";
import { readHiddenObservationProjection } from "./hidden-observation";
import { configPath, taskDir, taskEventFailureHintPath, teamDir } from "./paths";
import { readTaskEventFailureHintRecords } from "./task-event-failure-hints";
import * as teamEvents from "./team-events";
import * as teams from "./teams";

const fixtures: string[] = [];

function fixtureName(): string {
  const name = `coordination-mixed-records-${process.pid}-${Date.now()}-${fixtures.length}`;
  fixtures.push(name);
  return name;
}

function taskEnvelope(teamName: string, version: string) {
  return {
    task: {
      id: "current-task",
      title: "Current Task",
      description: "Compatibility description.",
      acceptanceCriteria: "Compatibility acceptance criteria.",
      status: "open" as const,
      relations: [],
      version,
      provenance: { authority: "beads" as const, teamName },
    },
    taskMetadata: {
      schema: TASK_METADATA_SCHEMA,
      goal: "Keep Coordination observations complete.",
      current_context: "Current Task evidence.",
    },
  };
}

function sessionContext(sessionFile: string) {
  const branch: any[] = [];
  return {
    cwd: process.cwd(),
    mode: "tui",
    isIdle: vi.fn(() => false),
    sessionManager: {
      getSessionId: vi.fn(() => sessionFile),
      getSessionFile: vi.fn(() => sessionFile),
      getBranch: vi.fn(() => branch),
      getEntries: vi.fn(() => branch),
      buildContextEntries: vi.fn(() => branch),
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn(), setTitle: vi.fn() },
    branch,
  };
}

function registeredLeaderHarness() {
  const tools = new Map<string, RegisteredToolLike>();
  const handlers = new Map<string, Array<(event: any, context: any) => unknown>>();
  piTeams({
    registerTool(tool: RegisteredToolLike) { tools.set(tool.name, tool); },
    registerMessageRenderer() {},
    on(event: string, handler: (event: any, context: any) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: vi.fn(), appendEntry: vi.fn(), sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => []), getAllTools: vi.fn(() => []), setActiveTools: vi.fn(),
  } as never);
  return {
    tool(name: string) {
      const tool = tools.get(name);
      expect(tool, `missing registered ${name} tool`).toBeDefined();
      return tool!;
    },
    async emit(event: string, payload: any, context: any) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, context);
    },
  };
}

async function invoke(harness: ReturnType<typeof registeredLeaderHarness>, context: ReturnType<typeof sessionContext>, callId: string, view: "snapshot" | "updates") {
  await harness.emit("tool_call", { toolName: "team_sync" }, context);
  return captureTrioProjection({ tool: harness.tool("team_sync"), args: { view }, context, toolCallId: callId });
}

async function acknowledge(harness: ReturnType<typeof registeredLeaderHarness>, context: ReturnType<typeof sessionContext>, callId: string, resultText: string, entryId: string) {
  context.branch.push({
    type: "message",
    id: entryId,
    parentId: context.branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text: resultText }], isError: false, timestamp: Date.now() },
  });
  await harness.emit("before_provider_request", { payload: { persistedResult: resultText } }, context);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of fixtures.splice(0)) {
    fs.rmSync(teamDir(name), { recursive: true, force: true });
    fs.rmSync(taskDir(name), { recursive: true, force: true });
  }
});

describe("mixed Coordination observation records through registered team_sync", () => {
  it("keeps legacy and malformed derived evidence outside fresh state until the exact persisted result acknowledges it", async () => {
    const name = fixtureName();
    const sessionFile = `/tmp/${name}-lead.jsonl`;
    await teams.createTeam(name, sessionFile, "lead-agent", "Mixed Coordination record fixture");
    const config = await teams.readConfig(name);
    config.logicalWorkers = [{ name: "worker", scope: "mixed-record fixture" }];
    teams.writeConfigAtomic(configPath(name), config);
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_LAUNCH_ID", "");

    let version = "task-v1";
    vi.spyOn(DurableTaskAuthorityRead.prototype, "listTaskIds").mockResolvedValue(["current-task"]);
    const hydrate = vi.spyOn(DurableTaskAuthorityRead.prototype, "readTaskAuthorityRecordEnvelopes").mockImplementation(async () => [taskEnvelope(name, version)]);
    const harness = registeredLeaderHarness();
    const context = sessionContext(sessionFile);

    const snapshot = await invoke(harness, context, "mixed-snapshot", "snapshot");
    expect(snapshot.execution).toEqual({ kind: "returned", isError: false });
    await acknowledge(harness, context, "mixed-snapshot", snapshot.model!.text, "snapshot-entry");
    const baseline = await readHiddenObservationProjection(name, {
      teamEpochId: config.epochId!, exactSessionId: sessionFile, branchLineage: ["snapshot-entry"],
    });
    expect(baseline).toMatchObject({ kind: "found", projection: { teamEventCursor: "0", authorityRevisions: { team_events: "0", task_event_failure_hints: "0" } } });
    if (baseline.kind !== "found") throw new Error("Expected acknowledged snapshot baseline.");

    version = "task-v2";
    await teamEvents.appendTeamEvent(name, {
      type: "worker", worker: "worker", membershipId: "legacy-membership", phase: "session_bound",
    });
    await teamEvents.appendTeamEvent(name, {
      type: "task", ref: { taskId: "current-task", version: taskVersionRef("task-v2") }, change: "status", actor: "worker",
    });
    fs.appendFileSync(taskEventFailureHintPath(name), `${JSON.stringify({
      schema: "pi-teams-task-event-failure-hint/1", teamEpochId: config.epochId, taskId: "current-task",
      taskVersion: taskVersionRef("task-v2"), actor: "worker", at: "2026-08-10T00:00:00.000Z",
    })}\nnot-json\n${JSON.stringify({
      schema: "pi-teams-task-event-failure-hint/1", teamEpochId: config.epochId, taskId: "current-task",
      taskVersion: taskVersionRef("task-v2"), actor: "worker", at: "2026-08-10T00:00:00.000Z", cursor: "bad",
    })}\n`);

    const update = await invoke(harness, context, "mixed-update", "updates");
    const current = {
      id: "current-task", title: "Current Task", status: "open", relations: [],
      dependency_state: { kind: "ready", active_blocker_ids: [] },
      current_context: "Current Task evidence.", version: taskVersionRef("task-v2"),
      goal: "Keep Coordination observations complete.",
    };
    const raw = {
      kind: "updates", team_changes: [],
      worker_changes: [{ worker: "worker", scope: "mixed-record fixture", kind: "connected", text: "Worker worker session bound." }],
      task_changes: [{ task_id: "current-task", change_kinds: ["status"], journal_entries: [], current }],
      alerts: [],
    };
    expect(update.execution).toEqual({ kind: "returned", isError: false });
    expect(update.machine).toEqual({ details: raw, json: JSON.stringify(raw) });
    expect(update.model).toEqual({ content: [{ type: "text", text: JSON.stringify(raw) }], text: JSON.stringify(raw) });
    expect(hydrate).toHaveBeenCalledTimes(2);
    const historicalHints = readTaskEventFailureHintRecords(name);
    expect(historicalHints).toHaveLength(1);
    expect(historicalHints[0]).toMatchObject({ taskId: "current-task", taskVersion: taskVersionRef("task-v2") });
    expect(historicalHints[0]).not.toHaveProperty("cursor");

    const beforeAcknowledgement = await readHiddenObservationProjection(name, {
      teamEpochId: config.epochId!, exactSessionId: sessionFile, branchLineage: ["snapshot-entry"],
    });
    expect(beforeAcknowledgement).toEqual(baseline);
    await acknowledge(harness, context, "mixed-update", update.model!.text, "mixed-update-entry");

    const acknowledgedLineage = ["snapshot-entry", "mixed-update-entry"];
    const afterAcknowledgement = await readHiddenObservationProjection(name, {
      teamEpochId: config.epochId!, exactSessionId: sessionFile, branchLineage: acknowledgedLineage,
    });
    expect(afterAcknowledgement).toMatchObject({
      kind: "found",
      projection: { teamEventCursor: "2", authorityRevisions: { team_events: "2", task_event_failure_hints: "0" } },
    });
    if (afterAcknowledgement.kind !== "found") throw new Error("Expected acknowledged update projection.");
    expect(afterAcknowledgement.projection.authorityRevisions).toEqual({
      team_events: "2",
      task_projection: expect.any(String),
      task_event_failure_hints: "0",
    });
    expect(afterAcknowledgement.projection.authorityRevisions.task_projection).not.toBe(baseline.projection.authorityRevisions.task_projection);

    const caughtUp = await invoke(harness, context, "mixed-caught-up", "updates");
    const caughtUpRaw = { kind: "caught_up", head: 2, epoch_id: config.epochId!, state_changed: false, observation_advanced: true };
    expect(caughtUp.machine).toEqual({ details: caughtUpRaw, json: JSON.stringify(caughtUpRaw) });
    expect(caughtUp.model).toEqual({ content: [{ type: "text", text: JSON.stringify({ kind: "caught_up", head: 2, epoch_id: config.epochId! }) }], text: JSON.stringify({ kind: "caught_up", head: 2, epoch_id: config.epochId! }) });
  });
});
