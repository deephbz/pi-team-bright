import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  AlertSendParametersSchema,
  EnsureWorkerParametersSchema,
  TaskCreateParametersSchema,
  TaskLinkParametersSchema,
  TaskReadParametersSchema,
  TaskUpdateParametersSchema,
  TeamCreateParametersSchema,
  TeamShutdownParametersSchema,
  TeamSyncParametersSchema,
  WorkerStopParametersSchema,
} from "./catalog";
import {
  InMemoryModelToolTeamPort,
  exactLeaderSessionId,
  registerModelToolJourney,
} from "./runtime";
import { assembleToolResult } from "./result-projection";
import { taskVersionRef } from "./task-version-ref";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: unknown;
};

type RegisteredTool = {
  name: string;
  parameters: any;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate: undefined,
    ctx: ReturnType<typeof exactSessionContext>,
  ) => Promise<ToolResult>;
};

function exactSessionContext(exactSessionId: string) {
  return {
    sessionManager: {
      getSessionId: () => exactSessionId,
    },
  };
}

function registerJourney() {
  const tools = new Map<string, RegisteredTool>();
  const port = new InMemoryModelToolTeamPort();
  const journey = registerModelToolJourney({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never, port);

  async function invoke(name: string, toolCallId: string, params: unknown, exactSessionId: string) {
    const tool = tools.get(name);
    expect(tool, `missing registered tool ${name}`).toBeDefined();
    if (!Check(tool!.parameters, params)) {
      throw new Error(`Provider schema rejected ${name} parameters.`);
    }
    return tool!.execute(
      toolCallId,
      params,
      new AbortController().signal,
      undefined,
      exactSessionContext(exactSessionId),
    );
  }

  return { tools, invoke, port, journey };
}

function canonicalDetails(result: ToolResult): any {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  return result.details;
}

describe("first model-tool journey through the Pi registration adapter", () => {
  it("registers the exact accepted provider schemas and rejects low-level fields", async () => {
    const { tools, invoke } = registerJourney();

    expect([...tools.keys()]).toEqual(["team_create", "team_sync", "ensure_worker", "task_create", "task_read", "task_update", "worker_stop", "team_shutdown", "task_link", "alert_send"]);
    expect(tools.get("team_create")!.parameters).toBe(TeamCreateParametersSchema);
    expect(tools.get("ensure_worker")!.parameters).toBe(EnsureWorkerParametersSchema);
    expect(tools.get("team_sync")!.parameters).toBe(TeamSyncParametersSchema);
    expect(tools.get("task_create")!.parameters).toBe(TaskCreateParametersSchema);
    expect(tools.get("task_read")!.parameters).toBe(TaskReadParametersSchema);
    expect(tools.get("task_update")!.parameters).toBe(TaskUpdateParametersSchema);

    const exactSessionId = "019fc274-f97e-7910-b6b6-579a20b3b1d0";
    const rejectedCalls = [
      ["team_create", { name: "release-team", purpose: "Prepare the release.", separate_windows: true }],
      ["team_create", { name: "release-team", purpose: "Prepare the release.", task_backend: "beads" }],
      ["ensure_worker", { name: "verifier", scope: "Own release verification.", team_name: "release-team" }],
      ["ensure_worker", { name: "verifier", scope: "Own release verification.", cwd: "/tmp/work" }],
      ["ensure_worker", { name: "verifier", scope: "Own release verification.", task_id: "task-1" }],
      ["team_sync", { view: "snapshot", team_name: "release-team" }],
      ["team_sync", { view: "updates", cursor: "12" }],
      ["team_sync", { view: "updates", wait_ms: 30_000 }],
      ["team_sync", { view: "snapshot", continuation: "opaque" }],
      ["team_sync", { view: "snapshot", limit: 20 }],
      ["task_create", { tasks: [{ title: "Verify", goal: "Verify the release.", team_name: "release-team" }] }],
      ["task_create", { tasks: [{ title: "Verify", goal: "Verify the release.", backend: "beads" }] }],
      ["task_read", { task_ids: [] }],
      ["task_read", { task_ids: ["task-1"], team_name: "release-team" }],
      ["task_update", { updates: [] }],
      ["task_update", { updates: [{ task_id: "task-1", operation_id: "op-1", expected_version: taskVersionRef("task_v1"), current_context: "Assigned.", journal_entries: [], team_name: "release-team" }] }],
    ] as const;

    for (const [name, params] of rejectedCalls) {
      await expect(invoke(name, `reject-${name}`, params, exactSessionId), JSON.stringify(params))
        .rejects.toThrow(`Provider schema rejected ${name} parameters.`);
    }
  });

  it("maps each registered tool through ordered leader setup to its exact port method", async () => {
    const calls: string[] = [];
    const port = Object.fromEntries([
      ["createTeam", "team_create"],
      ["readTeamSync", "team_sync"],
      ["ensureWorker", "ensure_worker"],
      ["createTask", "task_create"],
      ["readTasks", "task_read"],
      ["updateTasks", "task_update"],
      ["stopWorker", "worker_stop"],
      ["shutdownTeam", "team_shutdown"],
      ["linkTask", "task_link"],
      ["sendAlert", "alert_send"],
    ].map(([method, tool]) => [method, async () => {
      calls.push(method);
      throw new Error(`port:${tool}`);
    }])) as Record<string, (...arguments_: unknown[]) => Promise<never>> & {
      setLeaderSessionFile: (session: string, file: string) => void;
      setLeaderLaunchContext: (session: string, context: unknown) => void;
    };
    port.setLeaderSessionFile = (session, file) => { calls.push(`session:${session}:${file}`); };
    port.setLeaderLaunchContext = (session, context) => { calls.push(`launch:${session}:${JSON.stringify(context)}`); };

    const tools = new Map<string, RegisteredTool>();
    registerModelToolJourney({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as never, port as never);
    const sessionId = "019fc274-f97e-7910-b6b6-579a20b3b1d0";
    const sessionFile = "/tmp/leader.jsonl";
    const ctx = {
      cwd: "/workspace",
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
    } as ReturnType<typeof exactSessionContext>;
    const cases: Array<[string, unknown, unknown]> = [
      ["team_create", { name: "team", purpose: "Purpose." }, TeamCreateParametersSchema],
      ["team_sync", { view: "snapshot" }, TeamSyncParametersSchema],
      ["ensure_worker", { name: "worker", scope: "Scope." }, EnsureWorkerParametersSchema],
      ["task_create", { tasks: [{ operation_id: "create", title: "Task", goal: "Goal." }] }, TaskCreateParametersSchema],
      ["task_read", { task_ids: ["task-1"] }, TaskReadParametersSchema],
      ["task_update", { updates: [{ task_id: "task-1", operation_id: "update", expected_version: taskVersionRef("task_v1"), current_context: "Update." }] }, TaskUpdateParametersSchema],
      ["worker_stop", { worker: "worker" }, WorkerStopParametersSchema],
      ["team_shutdown", {}, TeamShutdownParametersSchema],
      ["task_link", { task_id: "task-1", target_id: "task-2", relation: "related", action: "add" }, TaskLinkParametersSchema],
      ["alert_send", { target: { kind: "worker", name: "worker" }, kind: "attention", text: "Review." }, AlertSendParametersSchema],
    ];

    for (const [name, parameters, schema] of cases) {
      expect(Check(schema as never, parameters)).toBe(true);
      await expect(tools.get(name)!.execute(`call-${name}`, parameters, new AbortController().signal, undefined, ctx))
        .rejects.toThrow(`port:${name}`);
    }
    expect(calls).toEqual(cases.flatMap(([name]) => [
      `session:${sessionId}:${sessionFile}`,
      `launch:${sessionId}:{"cwd":"/workspace","projectTrusted":true}`,
      ({ team_create: "createTeam", team_sync: "readTeamSync", ensure_worker: "ensureWorker", task_create: "createTask", task_read: "readTasks", task_update: "updateTasks", worker_stop: "stopWorker", team_shutdown: "shutdownTeam", task_link: "linkTask", alert_send: "sendAlert" } as Record<string, string>)[name],
    ]));
  });

  it("keeps Alert result projection and in-memory debug revision separate from Team and Task authority", async () => {
    const { invoke, port } = registerJourney();
    const session = "019fc274-f97e-7910-b6b6-579a20b3b1d0";
    await invoke("team_create", "create", { name: "release-team", purpose: "Prepare the release." }, session);
    await invoke("ensure_worker", "worker", { name: "verifier", scope: "Own release verification." }, session);
    const revision = port.readDebugRevision();

    const alert = canonicalDetails(await invoke("alert_send", "alert", {
      target: { kind: "worker", name: "verifier" },
      kind: "attention",
      text: "Review the release evidence.",
    }, session));

    expect(alert).toEqual({
      kind: "alert_sent",
      alert_id: "alert-3",
      accepted_recipients: ["verifier"],
      failed_recipients: [],
      task_state_changed: false,
    });
    expect(port.readDebugRevision()).toBe(revision);
  });

  it("rejects a malformed semantic result before model content exists", () => {
    let emitted: ToolResult | undefined;

    expect(() => {
      emitted = assembleToolResult("team_create", {
        kind: "team_created",
        team: {
          name: "release-team",
          purpose: "Prepare the release.",
          lifecycle: "connected",
        },
      } as never);
    }).toThrow("Invalid semantic result for team_create.");
    expect(emitted).toBeUndefined();
  });

  it("returns ordered independent Task outcomes and preserves failure semantics", async () => {
    const { invoke } = registerJourney();
    const leaderSessionId = "019fc274-f97e-7910-b6b6-579a20b3b1d0";

    await invoke("team_create", "create", { name: "release-team", purpose: "Prepare the release." }, leaderSessionId);
    const batch = canonicalDetails(await invoke(
      "task_create",
      "batch",
      {
        tasks: [
          { operation_id: "missing-worker", title: "Missing Worker", goal: "Refuse this item without changing Team state.", assignee: "missing-worker" },
          { operation_id: "unassigned-task", title: "Unassigned Task", goal: "Create this independent open Task and report its receipt." },
        ],
      },
      leaderSessionId,
    ));

    expect(batch).toEqual({
      kind: "task_create_batch",
      outcomes: [
        {
          kind: "refused",
          input_index: 0,
          operation_id: "missing-worker",
          reason: "worker_unavailable",
          message: expect.any(String),
          state_changed: false,
        },
        {
          kind: "created",
          input_index: 1,
          operation_id: "unassigned-task",
          task: {
            id: "task-1",
            title: "Unassigned Task",
            goal: "Create this independent open Task and report its receipt.",
            status: "open",
            current_context: "Work has not started.",
            version: expect.stringMatching(/^v_[0-9a-f]{16}$/),
          },
        },
      ],
    });
  });

  it("replays mixed create batches in input order without new Task state", async () => {
    const { invoke, port } = registerJourney();
    const leaderSessionId = "019fc274-f97e-7910-b6b6-579a20b3b1d0";
    await invoke("team_create", "create", { name: "release-team", purpose: "Prepare the release." }, leaderSessionId);
    const first = canonicalDetails(await invoke("task_create", "first-batch", {
      tasks: [
        { operation_id: "create-alpha", title: "Alpha", goal: "Create the first independent Task." },
        { operation_id: "missing-worker", title: "Unavailable", goal: "Keep this refusal independent.", assignee: "missing" },
      ],
    }, leaderSessionId));
    const second = canonicalDetails(await invoke("task_create", "reordered-retry", {
      tasks: [
        { operation_id: "missing-worker", title: "Unavailable", goal: "Keep this refusal independent.", assignee: "missing" },
        { operation_id: "create-alpha", title: "Alpha", goal: "Create the first independent Task." },
      ],
    }, leaderSessionId));

    expect(first.outcomes.map((outcome: { kind: string; operation_id: string }) => [outcome.kind, outcome.operation_id])).toEqual([
      ["created", "create-alpha"],
      ["refused", "missing-worker"],
    ]);
    expect(second.outcomes.map((outcome: { kind: string; operation_id: string }) => [outcome.kind, outcome.operation_id])).toEqual([
      ["refused", "missing-worker"],
      ["created", "create-alpha"],
    ]);
    expect(second.outcomes[1].task.id).toBe(first.outcomes[0].task.id);
    const snapshot = await port.readSnapshot(leaderSessionId as ReturnType<typeof exactLeaderSessionId>);
    expect(snapshot.kind === "snapshot" && snapshot.tasks).toHaveLength(1);
  });

  it("rejects duplicate Task IDs before any update mutation", async () => {
    const { invoke, port } = registerJourney();
    const leaderSessionId = "019fc274-f97e-7910-b6b6-579a20b3b1d0";
    await invoke("team_create", "create", { name: "release-team", purpose: "Prepare the release." }, leaderSessionId);
    await invoke("ensure_worker", "worker", { name: "verifier", scope: "Own release verification." }, leaderSessionId);
    await invoke("task_create", "task", { tasks: [{ operation_id: "create-verify", title: "Verify", goal: "Verify the release.", assignee: "verifier" }] }, leaderSessionId);
    const revisionBefore = port.readDebugRevision();
    const duplicate = canonicalDetails(await invoke("task_update", "duplicate", {
      updates: [
        { task_id: "task-1", operation_id: "op-1", expected_version: taskVersionRef("task_v1"), current_context: "First.", journal_entries: [{ kind: "decision", text: "First." }] },
        { task_id: "task-1", operation_id: "op-2", expected_version: taskVersionRef("task_v1"), current_context: "Second.", journal_entries: [{ kind: "decision", text: "Second." }] },
      ],
    }, leaderSessionId));
    expect(duplicate).toEqual({
      kind: "refused",
      reason: "duplicate_task_id",
      message: expect.any(String),
      state_changed: false,
    });
    expect(port.readDebugRevision()).toBe(revisionBefore);
  });

  it("scopes operation replay by Task and keeps the Worker nonterminal index current", async () => {
    const { invoke, port } = registerJourney();
    const leaderSessionId = "019fc274-f97e-7910-b6b6-579a20b3b1d0";
    await invoke("team_create", "create", { name: "release-team", purpose: "Prepare the release." }, leaderSessionId);
    await invoke("ensure_worker", "worker", { name: "verifier", scope: "Own release verification." }, leaderSessionId);
    await invoke("task_create", "task-1", { tasks: [{ operation_id: "create-verify-one", title: "Verify one", goal: "Verify one release input.", assignee: "verifier" }, { operation_id: "create-verify-two", title: "Verify two", goal: "Verify a second release input.", assignee: "verifier" }] }, leaderSessionId);

    const sharedUpdate = (taskId: string, text: string) => ({
      updates: [{
        task_id: taskId,
        operation_id: "shared-operation",
        expected_version: taskVersionRef("task_v1"),
        current_context: text,
        journal_entries: [{ kind: "decision" as const, text }],
      }],
    });
    const first = canonicalDetails(await invoke("task_update", "update-one", sharedUpdate("task-1", "Task one is assigned."), leaderSessionId));
    const second = canonicalDetails(await invoke("task_update", "update-two", sharedUpdate("task-2", "Task two is assigned."), leaderSessionId));
    expect(first).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "updated", task_id: "task-1", operation_id: "shared-operation" }] });
    expect(second).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "updated", task_id: "task-2", operation_id: "shared-operation" }] });

    const closeInput = {
      updates: [{
        task_id: "task-1",
        operation_id: "close-one",
        expected_version: first.outcomes[0].task.version,
        current_context: "Task one is closed after coordination review.",
        journal_entries: [{ kind: "decision" as const, text: "Close Task one." }],
        status: "closed" as const,
      }],
    };
    const closed = canonicalDetails(await invoke("task_update", "close-one", closeInput, leaderSessionId));
    expect(closed).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "updated", task: { id: "task-1", status: "closed", version: expect.stringMatching(/^v_[0-9a-f]{16}$/) } }] });
    const afterClose = canonicalDetails(await invoke("team_sync", "sync-after-close", { view: "snapshot" }, leaderSessionId));
    expect(afterClose.workers[0].nonterminal_task_ids).toEqual(["task-2"]);
    port.acknowledgePendingObservation(exactLeaderSessionId(leaderSessionId), "after-close", ["after-close"]);

    const replay = canonicalDetails(await invoke("task_update", "close-replay", closeInput, leaderSessionId));
    expect(replay).toEqual(closed);
    const operationConflict = canonicalDetails(await invoke("task_update", "close-conflict", {
      updates: [{ ...closeInput.updates[0], current_context: "Different input." }],
    }, leaderSessionId));
    expect(operationConflict).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "refused", reason: "operation_conflict", current_task: { id: "task-1", status: "closed" } }] });

    const reopened = canonicalDetails(await invoke("task_update", "reopen-one", {
      updates: [{
        task_id: "task-1",
        operation_id: "reopen-one",
        expected_version: closed.outcomes[0].task.version,
        current_context: "Task one is nonterminal and awaits follow-up.",
        journal_entries: [{ kind: "decision", text: "Reopen Task one for follow-up." }],
        status: "in_progress",
      }],
    }, leaderSessionId));
    expect(reopened).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "updated", task: { id: "task-1", status: "in_progress", version: expect.stringMatching(/^v_[0-9a-f]{16}$/) } }] });
    const afterReopen = canonicalDetails(await invoke("team_sync", "sync-after-reopen", { view: "snapshot" }, leaderSessionId));
    expect(afterReopen.workers[0].nonterminal_task_ids).toEqual(["task-1", "task-2"]);
  });

  it("stages snapshot baselines, replays pending results, waits, wakes, cancels, and respects branch lineage", async () => {
    const { invoke, port, journey } = registerJourney();
    const leaderSessionId = "019fc274-f97e-7910-b6b6-579a20b3b1d0";
    const session = exactLeaderSessionId(leaderSessionId);
    await invoke("team_create", "create", { name: "release-team", purpose: "Prepare the release." }, leaderSessionId);
    await invoke("ensure_worker", "worker", { name: "verifier", scope: "Own release verification." }, leaderSessionId);
    await invoke("task_create", "task", { tasks: [{ operation_id: "create-verify", title: "Verify", goal: "Verify the release.", assignee: "verifier" }] }, leaderSessionId);

    const required = canonicalDetails(await invoke("team_sync", "updates-before-snapshot", { view: "updates" }, leaderSessionId));
    expect(required).toEqual({ kind: "snapshot_required", message: expect.any(String), state_changed: false, observation_advanced: false });

    const snapshot = canonicalDetails(await invoke("team_sync", "snapshot", { view: "snapshot" }, leaderSessionId));
    const replayBeforeAck = canonicalDetails(await invoke("team_sync", "snapshot-replay", { view: "snapshot" }, leaderSessionId));
    expect(replayBeforeAck).toEqual(snapshot);
    port.setBranchContext(session, ["snapshot-entry"]);
    expect(port.acknowledgePendingObservation(session, "snapshot-entry", ["snapshot-entry"])).toBe(true);

    const updated = canonicalDetails(await invoke("task_update", "update", {
      updates: [{
        task_id: "task-1",
        operation_id: "progress-1",
        expected_version: taskVersionRef("task_v1"),
        current_context: "Task is assigned but awaits a Worker carrier.",
        journal_entries: [{ kind: "decision", text: "Keep the Task open until a Worker carrier is available." }],
        status: "open",
      }],
    }, leaderSessionId));
    const updates = canonicalDetails(await invoke("team_sync", "updates", { view: "updates" }, leaderSessionId));
    expect(updates).toMatchObject({ kind: "updates", task_changes: [{ task_id: "task-1", change_kinds: ["progress"], current: { version: expect.stringMatching(/^v_[0-9a-f]{16}$/) } }] });
    const updatesReplay = canonicalDetails(await invoke("team_sync", "updates-replay", { view: "updates" }, leaderSessionId));
    expect(updatesReplay).toEqual(updates);
    port.setBranchContext(session, ["updates-entry"]);
    expect(port.acknowledgePendingObservation(session, "updates-entry", ["updates-entry"])).toBe(true);

    const abort = new AbortController();
    const caughtUp = journey.executors.teamSync(session, { view: "updates" }, abort.signal, "caught-up");
    setTimeout(() => abort.abort(), 5);
    await expect(caughtUp).resolves.toMatchObject({ kind: "cancelled", state_changed: false, observation_advanced: false });

    await invoke("ensure_worker", "second-worker", { name: "second-verifier", scope: "Own a second independent verification path." }, leaderSessionId);
    const afterCancellation = canonicalDetails(await invoke("team_sync", "after-cancellation", { view: "updates" }, leaderSessionId));
    expect(afterCancellation).toMatchObject({ kind: "updates", worker_changes: [{ worker: "second-verifier", kind: "created" }] });
    port.setBranchContext(session, ["after-cancellation-entry"]);
    expect(port.acknowledgePendingObservation(session, "after-cancellation-entry", ["after-cancellation-entry"])).toBe(true);

    port.setBranchContext(session, ["branch-before-baseline"]);
    const branched = canonicalDetails(await invoke("team_sync", "branched-updates", { view: "updates" }, leaderSessionId));
    expect(branched).toEqual({ kind: "snapshot_required", message: expect.any(String), state_changed: false, observation_advanced: false });
    expect(updated.outcomes[0].task.current_context).toBe("Task is assigned but awaits a Worker carrier.");
  });

  it("wakes an updates wait with its original call identity and groups status changes", async () => {
    const { invoke, port, journey } = registerJourney();
    const leaderSessionId = "019fc274-f97e-7910-b6b6-579a20b3b1d0";
    const session = exactLeaderSessionId(leaderSessionId);

    await invoke("team_create", "create", { name: "release-team", purpose: "Prepare the release." }, leaderSessionId);
    await invoke("team_sync", "snapshot", { view: "snapshot" }, leaderSessionId);
    port.setBranchContext(session, ["snapshot-entry"]);
    expect(port.acknowledgePendingObservation(session, "snapshot-entry", ["snapshot-entry"])).toBe(true);

    const waiting = journey.executors.teamSync(session, { view: "updates" }, new AbortController().signal, "original-wait");
    await invoke("ensure_worker", "worker", { name: "verifier", scope: "Own release verification." }, leaderSessionId);
    const workerUpdate = await waiting;
    expect(workerUpdate).toMatchObject({
      kind: "updates",
      worker_changes: [{ worker: "verifier", kind: "created" }],
      task_changes: [],
    });
    expect(port.getPendingObservation(session)).toMatchObject({ toolCallId: "original-wait" });
    port.setBranchContext(session, ["worker-entry"]);
    expect(port.acknowledgePendingObservation(session, "worker-entry", ["worker-entry"])).toBe(true);

    await invoke("task_create", "task", { tasks: [{ operation_id: "create-verify", title: "Verify", goal: "Verify the release.", assignee: "verifier" }] }, leaderSessionId);
    const created = canonicalDetails(await invoke("team_sync", "created-task", { view: "updates" }, leaderSessionId));
    expect(created).toMatchObject({ kind: "updates", task_changes: [{ task_id: "task-1", change_kinds: ["created"] }] });
    port.setBranchContext(session, ["created-task-entry"]);
    expect(port.acknowledgePendingObservation(session, "created-task-entry", ["created-task-entry"])).toBe(true);

    await invoke("task_update", "status-change", {
      updates: [{
        task_id: "task-1",
        operation_id: "status-change",
        expected_version: taskVersionRef("task_v1"),
        current_context: "Verification is now in progress.",
        journal_entries: [{ kind: "progress", text: "Verification started." }],
        status: "in_progress",
      }],
    }, leaderSessionId);
    const statusChange = canonicalDetails(await invoke("team_sync", "status-change", { view: "updates" }, leaderSessionId));
    expect(statusChange).toMatchObject({ kind: "updates", task_changes: [{ task_id: "task-1", change_kinds: ["progress", "status"] }] });
    port.setBranchContext(session, ["status-change-entry"]);
    expect(port.acknowledgePendingObservation(session, "status-change-entry", ["status-change-entry"])).toBe(true);

    await invoke("task_update", "progress-only", {
      updates: [{
        task_id: "task-1",
        operation_id: "progress-only",
        expected_version: statusChange.task_changes[0].current.version,
        current_context: "Verification continues.",
        journal_entries: [{ kind: "progress", text: "Verification continues." }],
        status: "in_progress",
      }],
    }, leaderSessionId);
    const progressOnly = canonicalDetails(await invoke("team_sync", "progress-only", { view: "updates" }, leaderSessionId));
    expect(progressOnly).toMatchObject({ kind: "updates", task_changes: [{ task_id: "task-1", change_kinds: ["progress"] }] });
  });

  it("creates, establishes one logical Worker, and observes one Team through the exact leader Session", async () => {
    const { invoke, port } = registerJourney();
    const leaderSessionId = "019fc274-f97e-7910-b6b6-579a20b3b1d0";
    const unboundSessionId = "019fc275-107f-7638-b47d-4f50dc849e89";
    const team = {
      name: "release-team",
      purpose: "Prepare and verify the public release.",
      lifecycle: "active",
    } as const;
    const worker = {
      name: "release-verifier",
      scope: "Own independent release verification.",
      carrier: "absent",
    } as const;

    const created = canonicalDetails(await invoke(
      "team_create",
      "create-1",
      { name: team.name, purpose: team.purpose },
      leaderSessionId,
    ));
    expect(created).toEqual({ kind: "team_created", team });

    const repeated = canonicalDetails(await invoke(
      "team_create",
      "create-2",
      { name: "replacement-team", purpose: "Replace the original Team." },
      leaderSessionId,
    ));
    expect(repeated).toEqual({
      kind: "refused",
      reason: "active_team_exists",
      message: expect.any(String),
      state_changed: false,
    });

    const sameNameFromAnotherSession = canonicalDetails(await invoke(
      "team_create",
      "create-name-conflict",
      { name: team.name, purpose: "Attempt to acquire another Session's Team name." },
      unboundSessionId,
    ));
    expect(sameNameFromAnotherSession).toEqual({
      kind: "refused",
      reason: "name_unavailable",
      message: expect.any(String),
      state_changed: false,
    });

    const hiddenFromAnotherSession = canonicalDetails(await invoke(
      "team_sync",
      "sync-unbound",
      { view: "snapshot" },
      unboundSessionId,
    ));
    expect(hiddenFromAnotherSession).toEqual({
      kind: "unavailable",
      reason: "no_active_team",
      message: expect.any(String),
      state_changed: false,
      observation_advanced: false,
    });

    const unreadableFromAnotherSession = canonicalDetails(await invoke(
      "task_read",
      "read-unbound",
      { task_ids: ["task-1", "task-missing"] },
      unboundSessionId,
    ));
    expect(unreadableFromAnotherSession).toEqual({
      kind: "unavailable",
      reason: "no_active_team",
      message: expect.any(String),
      state_changed: false,
    });

    const ensured = canonicalDetails(await invoke(
      "ensure_worker",
      "ensure-create",
      { name: worker.name, scope: worker.scope },
      leaderSessionId,
    ));
    expect(ensured).toEqual({
      kind: "worker_ensured",
      effect: "created",
      worker,
    });

    const reused = canonicalDetails(await invoke(
      "ensure_worker",
      "ensure-reuse",
      { name: worker.name, scope: worker.scope },
      leaderSessionId,
    ));
    expect(reused).toEqual({
      kind: "worker_ensured",
      effect: "reused",
      worker,
    });

    const conflict = canonicalDetails(await invoke(
      "ensure_worker",
      "ensure-conflict",
      { name: worker.name, scope: "Own release construction instead." },
      leaderSessionId,
    ));
    expect(conflict).toEqual({
      kind: "refused",
      reason: "name_scope_conflict",
      existing_worker: worker,
      state_changed: false,
    });

    const task = canonicalDetails(await invoke(
      "task_create",
      "create-task",
      {
        tasks: [{
          operation_id: "create-release-candidate",
          title: "Verify release candidate",
          goal: "Confirm the candidate installs cleanly and report the external verification signal.",
          assignee: worker.name,
        }],
      },
      leaderSessionId,
    ));
    expect(task).toEqual({
      kind: "task_create_batch",
      outcomes: [{
        kind: "created",
        input_index: 0,
        operation_id: "create-release-candidate",
        task: {
          id: "task-1",
          title: "Verify release candidate",
          goal: "Confirm the candidate installs cleanly and report the external verification signal.",
          status: "open",
          assignee: worker.name,
          current_context: "Work has not started.",
          version: expect.stringMatching(/^v_[0-9a-f]{16}$/),
        },
      }],
    });

    const revisionBeforeRead = port.readDebugRevision();
    const read = canonicalDetails(await invoke(
      "task_read",
      "read-task",
      { task_ids: ["task-1", "task-1", "task-missing"] },
      leaderSessionId,
    ));
    expect(port.readDebugRevision()).toBe(revisionBeforeRead);
    expect(read).toEqual({
      kind: "task_read_batch",
      outcomes: [
        {
          kind: "found",
          input_index: 0,
          task_id: "task-1",
          task: {
            id: "task-1",
            title: "Verify release candidate",
            goal: "Confirm the candidate installs cleanly and report the external verification signal.",
            status: "open",
            assignee: worker.name,
            current_context: "Work has not started.",
            version: expect.stringMatching(/^v_[0-9a-f]{16}$/),
          },
        },
        {
          kind: "found",
          input_index: 1,
          task_id: "task-1",
          task: {
            id: "task-1",
            title: "Verify release candidate",
            goal: "Confirm the candidate installs cleanly and report the external verification signal.",
            status: "open",
            assignee: worker.name,
            current_context: "Work has not started.",
            version: expect.stringMatching(/^v_[0-9a-f]{16}$/),
          },
        },
        {
          kind: "missing",
          input_index: 2,
          task_id: "task-missing",
          reason: "task_not_found",
          state_changed: false,
        },
      ],
    });

    const updateInput = {
      updates: [{
        task_id: "task-1",
        operation_id: "decision-1",
        expected_version: taskVersionRef("task_v1"),
        current_context: "Task is assigned but awaits a Worker carrier.",
        journal_entries: [{ kind: "decision", text: "Keep the Task open until a Worker carrier is available." }],
        status: "open",
      }],
    } as const;
    const update = canonicalDetails(await invoke("task_update", "update-task", updateInput, leaderSessionId));
    expect(update).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{
        kind: "updated",
        input_index: 0,
        task_id: "task-1",
        operation_id: "decision-1",
        task: {
          id: "task-1",
          title: "Verify release candidate",
          goal: "Confirm the candidate installs cleanly and report the external verification signal.",
          status: "open",
          assignee: worker.name,
          current_context: "Task is assigned but awaits a Worker carrier.",
          version: expect.stringMatching(/^v_[0-9a-f]{16}$/),
        },
        journal_entries: [{
          id: expect.any(String),
          at: expect.any(String),
          actor: "leader",
          kind: "decision",
          text: "Keep the Task open until a Worker carrier is available.",
        }],
      }],
    });
    const replay = canonicalDetails(await invoke("task_update", "update-replay", updateInput, leaderSessionId));
    expect(replay).toEqual(update);
    const updateConflict = canonicalDetails(await invoke("task_update", "update-conflict", {
      updates: [{ ...updateInput.updates[0], operation_id: "decision-conflict", expected_version: taskVersionRef("task_v1") }],
    }, leaderSessionId));
    expect(updateConflict).toMatchObject({
      kind: "task_update_batch",
      outcomes: [{
        kind: "refused",
        input_index: 0,
        task_id: "task-1",
        operation_id: "decision-conflict",
        reason: "version_conflict",
        current_task: { id: "task-1", version: expect.stringMatching(/^v_[0-9a-f]{16}$/), current_context: "Task is assigned but awaits a Worker carrier." },
        state_changed: false,
      }],
    });

    const snapshot = canonicalDetails(await invoke(
      "team_sync",
      "sync-snapshot",
      { view: "snapshot" },
      leaderSessionId,
    ));
    expect(snapshot).toEqual({
      kind: "snapshot",
      team,
      workers: [{ ...worker, nonterminal_task_ids: ["task-1"] }],
      tasks: [{
        id: "task-1",
        title: "Verify release candidate",
        goal: "Confirm the candidate installs cleanly and report the external verification signal.",
        status: "open",
        assignee: worker.name,
        current_context: "Task is assigned but awaits a Worker carrier.",
        version: expect.stringMatching(/^v_[0-9a-f]{16}$/),
      }],
    });
  });
});
