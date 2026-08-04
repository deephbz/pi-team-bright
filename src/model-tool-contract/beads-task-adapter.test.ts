import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BeadsTaskStore,
  CANDIDATE_TASK_METADATA_KEY,
  CANDIDATE_TASK_METADATA_SCHEMA,
  type BdRunner,
  type CandidateTaskAuthorityRecord,
  type CandidateTaskMetadata,
  type CreateTaskInput,
} from "../utils/beads";
import type { TaskFile } from "../utils/models";
import { configPath, teamDir } from "../utils/paths";
import {
  appendTaskEvidenceEvent,
  readTeamEvents,
} from "../utils/team-events";
import type { InternalTaskPublicationOptions, TaskCreateReceipt } from "../utils/tasks";
import {
  CandidateBeadsTaskAdapter,
  candidateUpdateEventEvidence,
  projectCandidateNonterminalTaskIds,
  refreshCandidateTaskMetadata,
  projectCandidateTaskChanges,
  projectCandidateTaskJournalEntry,
  type CandidateTaskAdapterAuthority,
} from "./beads-task-adapter";
import { taskVersionRef } from "./task-version-ref";

const createdTeams: string[] = [];

function task(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    id: "candidate-task-1",
    title: "Verify candidate",
    description: "compatibility description must not own goal",
    acceptanceCriteria: "compatibility acceptance must not own goal",
    status: "open",
    assignee: "verifier",
    relations: [],
    version: "beads_authority_version",
    provenance: { authority: "beads", teamName: "candidate-team" },
    ...overrides,
  };
}

function receipt(value: TaskFile): TaskCreateReceipt {
  return {
    task: value,
    changed: true,
    appliedOperations: ["create"],
    deliveryDegraded: false,
    deliveryWarnings: [],
    publication: {
      teamEvent: { appended: true },
      delivery: {
        attemptedRecipients: [],
        failedRecipients: [],
        recoveryRecordedFor: [],
        recoveryRecordFailedFor: [],
      },
    },
  };
}

function metadata(currentContext = "Work has not started."): CandidateTaskMetadata {
  return {
    schema: CANDIDATE_TASK_METADATA_SCHEMA,
    goal: "Verify the exact release digest.",
    current_context: currentContext,
  };
}

function authorityRecord(candidateMetadata?: unknown): CandidateTaskAuthorityRecord {
  return {
    task: task(),
    ...(candidateMetadata === undefined ? {} : { candidateMetadata }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(teamDir(teamName), { recursive: true, force: true });
  }
});

describe("durable candidate Task adapter", () => {
  it("creates through the existing Task authority and keeps metadata canonical", async () => {
    const create = vi.fn(async (_input: CreateTaskInput, _publication: InternalTaskPublicationOptions) => receipt(task()));
    const read = vi.fn(async () => authorityRecord(metadata()));
    const adapter = new CandidateBeadsTaskAdapter("candidate-team", "team-lead", { create, read });

    const created = await adapter.create({
      operationId: "create-candidate",
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      assignee: "verifier",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      title: "Verify candidate",
      description: "Verify the exact release digest.",
      idempotencyKey: "model-task-create:candidate-team:create-candidate",
      acceptanceCriteria: "Verify the exact release digest.",
      assignee: "verifier",
      internalMetadata: {
        [CANDIDATE_TASK_METADATA_KEY]: metadata(),
      },
    });
    expect(create.mock.calls[0][1]).toEqual({
      taskEventEvidence: [{ kind: "created", text: "Verify the exact release digest." }],
    });
    expect(created).toEqual({
      kind: "created",
      operationId: "create-candidate",
      task: {
        id: "candidate-task-1",
        title: "Verify candidate",
        goal: "Verify the exact release digest.",
        status: "open",
        assignee: "verifier",
        current_context: "Work has not started.",
        version: "beads_authority_version",
      },
      deliveryWarnings: [],
    });
  });

  it("recovers an unknown create outcome only through the same Team-scoped operation", async () => {
    let stored: CandidateTaskAuthorityRecord | undefined;
    let failAfterCreate = true;
    let authorityMutations = 0;
    const create = vi.fn(async (input: CreateTaskInput) => {
      expect(input.idempotencyKey).toBe("model-task-create:candidate-team:create-safe-1");
      if (!stored) {
        authorityMutations += 1;
        stored = authorityRecord(metadata());
      }
      return receipt(stored.task);
    });
    const read = vi.fn(async () => {
      if (failAfterCreate) {
        failAfterCreate = false;
        throw new Error("transport ended after Beads committed");
      }
      return stored!;
    });
    const adapter = new CandidateBeadsTaskAdapter("candidate-team", "team-lead", { create, read });
    const input = { operationId: "create-safe-1", title: "Verify candidate", goal: "Verify the exact release digest.", assignee: "verifier" };

    await expect(adapter.create(input)).resolves.toMatchObject({
      kind: "unknown_outcome",
      operationId: input.operationId,
    });
    await expect(adapter.create(input)).resolves.toMatchObject({
      kind: "created",
      operationId: input.operationId,
      task: { id: "candidate-task-1" },
    });
    await expect(adapter.create({ ...input, goal: "Different goal." })).resolves.toMatchObject({
      kind: "operation_conflict",
      operationId: input.operationId,
    });
    expect(authorityMutations).toBe(1);
  });

  it("reads object or CLI-string metadata and never infers goal from compatibility fields", async () => {
    const create = vi.fn(async () => receipt(task()));
    const records = [
      authorityRecord(metadata("Object context.")),
      authorityRecord(JSON.stringify(metadata("String context."))),
      authorityRecord(),
    ];
    const authority: CandidateTaskAdapterAuthority = {
      create,
      read: vi.fn(async () => records.shift()!),
    };
    const adapter = new CandidateBeadsTaskAdapter("candidate-team", "team-lead", authority);

    await expect(adapter.read("candidate-task-1")).resolves.toMatchObject({
      kind: "found",
      task: { goal: "Verify the exact release digest.", current_context: "Object context." },
    });
    await expect(adapter.read("candidate-task-1")).resolves.toMatchObject({
      kind: "found",
      task: { goal: "Verify the exact release digest.", current_context: "String context." },
    });
    await expect(adapter.read("candidate-task-1")).resolves.toMatchObject({
      kind: "contract_gap",
      reason: "candidate_metadata_absent",
      authorityVersion: "beads_authority_version",
    });
  });

  it("hydrates a snapshot candidate set with one multi-ID show and preserves metadata gaps", async () => {
    const ids = ["candidate-task-1", "candidate-task-2"];
    const commands: string[][] = [];
    const runner: BdRunner = {
      run: vi.fn(async (args) => {
        commands.push(args);
        const operation = args[3];
        if (operation === "list") {
          return {
            stdout: JSON.stringify(ids.map((id) => ({
              id,
              title: id,
              status: "open",
              labels: ["pi-teams:candidate-team"],
              metadata: {
                pi_teams_team: "candidate-team",
                [CANDIDATE_TASK_METADATA_KEY]: metadata(),
              },
            }))),
            stderr: "",
            exitCode: 0,
          };
        }
        if (operation === "show") {
          return {
            stdout: JSON.stringify(ids.map((id) => ({
              id,
              title: id,
              status: "open",
              labels: ["pi-teams:candidate-team"],
              metadata: {
                pi_teams_team: "candidate-team",
                ...(id === "candidate-task-1" ? { [CANDIDATE_TASK_METADATA_KEY]: metadata() } : {}),
              },
            }))),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`unexpected bd operation: ${operation}`);
      }),
    };
    const store = new BeadsTaskStore({ teamName: "candidate-team", workspace: "/tmp/candidate-team-authority", runner });
    const listed = await store.list();
    const records = await store.readCandidateTaskAuthorityRecords(listed.map((candidate) => candidate.id));

    const listCommands = commands.filter((args) => args[3] === "list");
    const showCommands = commands.filter((args) => args[3] === "show");
    expect(listCommands).toHaveLength(1);
    expect(listCommands[0]).toEqual([
      "--directory", "/tmp/candidate-team-authority", "--json",
      "list", "--label", "pi-teams:candidate-team", "--all", "--no-pager", "--limit", "0",
    ]);
    expect(showCommands).toHaveLength(1);
    expect(showCommands[0]).toEqual([
      "--directory", "/tmp/candidate-team-authority", "--json",
      "show", ...ids, "--include-dependents",
    ]);
    expect(showCommands.filter((args) => ids.filter((id) => args.includes(id)).length === 1)).toHaveLength(0);
    expect(records).toHaveLength(2);
    expect(records[0].candidateMetadata).toEqual(metadata());
    expect(records[1]).not.toHaveProperty("candidateMetadata");
  });

  it("projects batched candidate records with the same found and gap semantics", async () => {
    const read = vi.fn(async (taskId: string) => authorityRecord(metadata(`${taskId} context`)));
    const readMany = vi.fn(async (taskIds: readonly string[]) => taskIds.map((taskId) => ({
      ...authorityRecord(taskId === "candidate-task-2" ? undefined : metadata(`${taskId} context`)),
      task: task({ id: taskId }),
    })));
    const adapter = new CandidateBeadsTaskAdapter("candidate-team", "team-lead", {
      create: vi.fn(async () => receipt(task())),
      read,
      readMany,
    });

    await expect(adapter.readMany(["candidate-task-1", "candidate-task-2"])).resolves.toMatchObject([
      { kind: "found", task: { id: "candidate-task-1", current_context: "candidate-task-1 context" } },
      { kind: "contract_gap", reason: "candidate_metadata_absent", taskId: "candidate-task-2" },
    ]);
    expect(readMany).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("preserves write limits and marks oversized external display fields without mutating them", async () => {
    const records = [
      authorityRecord(metadata("a".repeat(2_000))),
      authorityRecord(metadata("👩🏽‍🚀".repeat(2_001))),
      authorityRecord({ ...metadata(), goal: "😀".repeat(501) }),
      { ...authorityRecord(metadata()), task: task({ title: "😀".repeat(41) }) },
    ];
    const adapter = new CandidateBeadsTaskAdapter("candidate-team", "team-lead", {
      create: vi.fn(async () => receipt(task())),
      read: vi.fn(async () => records.shift()!),
    });

    await expect(adapter.read("candidate-task-1")).resolves.toMatchObject({
      kind: "found",
      task: { current_context: "a".repeat(2_000) },
    });
    await expect(adapter.read("candidate-task-1")).resolves.toMatchObject({
      kind: "found",
      task: {
        current_context: expect.stringContaining("…"),
        projection_warnings: [{ truncated_fields: ["current_context"], incomplete_fields: [] }],
      },
    });
    await expect(adapter.read("candidate-task-1")).resolves.toMatchObject({
      kind: "found",
      task: {
        id: "candidate-task-1",
        goal_state: "incomplete",
        projection_warnings: [{ incomplete_fields: ["goal"] }],
        status: "open",
        assignee: "verifier",
        version: "beads_authority_version",
      },
    });
    await expect(adapter.read("candidate-task-1")).resolves.toMatchObject({
      kind: "found",
      task: { title: expect.stringContaining("…"), projection_warnings: [{ truncated_fields: ["title"] }] },
    });
  });

  it("returns a typed no-write gap instead of claiming CAS or operation replay", async () => {
    const authority: CandidateTaskAdapterAuthority = {
      create: vi.fn(async () => receipt(task())),
      read: vi.fn(async () => authorityRecord(metadata("Ready to update."))),
    };
    const adapter = new CandidateBeadsTaskAdapter("candidate-team", "team-lead", authority);

    await expect(adapter.update({
      taskId: "candidate-task-1",
      operationId: "operation-1",
      expectedVersion: taskVersionRef("beads_authority_version"),
      currentContext: "Update must not commit without CAS.",
      journalEntries: [{ kind: "decision", text: "Refuse the unsafe write." }],
    })).resolves.toMatchObject({
      kind: "contract_gap",
      reason: "beads_external_writer_atomicity_unavailable",
      unsupported: ["atomic_compare_and_swap", "task_scoped_operation_replay"],
      currentTask: { version: "beads_authority_version" },
    });
  });

  it("commits a candidate update and replays the durable operation record", async () => {
    let stored: CandidateTaskMetadata = metadata("Before update.");
    const update = vi.fn(async (_taskId: string, _input: any, nextMetadata: CandidateTaskMetadata) => {
      stored = nextMetadata;
      return {
        task: task({ version: "beads_authority_version_next", status: "in_progress" }),
        before: task(),
        appliedOperations: ["set:status", "append:note", "set:candidateTaskMetadata"],
        deliveryDegraded: false,
        deliveryWarnings: [],
      };
    });
    const authority: CandidateTaskAdapterAuthority = {
      create: vi.fn(async () => receipt(task())),
      read: vi.fn(async () => authorityRecord(stored)),
      update,
    };
    const adapter = new CandidateBeadsTaskAdapter("candidate-team", "team-lead", authority);
    const input = {
      taskId: "candidate-task-1",
      operationId: "operation-safe-1",
      expectedVersion: taskVersionRef("beads_authority_version"),
      currentContext: "Worker started.",
      journalEntries: [{ kind: "progress" as const, text: "Worker started." }],
      status: "in_progress" as const,
    };
    const first = await adapter.update(input);
    expect(first).toMatchObject({ kind: "updated", operationId: "operation-safe-1", task: { version: "beads_authority_version_next" } });
    const replay = await adapter.update(input);
    expect(replay).toMatchObject({ kind: "updated", operationId: "operation-safe-1" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("preserves replay metadata across a Worker context refresh", async () => {
    let storedTask = task({ version: "beads_v1" });
    let storedMetadata: CandidateTaskMetadata = metadata("Before update.");
    const update = vi.fn(async (_taskId: string, input: any, nextMetadata: CandidateTaskMetadata) => {
      storedMetadata = nextMetadata;
      storedTask = task({
        version: input.operationId === "operation-a" ? "beads_v2" : "beads_v3",
        status: input.status ?? storedTask.status,
      });
      return {
        task: storedTask,
        before: task(),
        appliedOperations: ["set:status", "append:note", "set:candidateTaskMetadata"],
        deliveryDegraded: false,
        deliveryWarnings: [],
      };
    });
    const authority: CandidateTaskAdapterAuthority = {
      create: vi.fn(async () => receipt(task())),
      read: vi.fn(async () => ({ task: storedTask, candidateMetadata: storedMetadata })),
      update,
    };
    const adapter = new CandidateBeadsTaskAdapter("candidate-team", "team-lead", authority);
    const operationA = {
      taskId: "candidate-task-1",
      operationId: "operation-a",
      expectedVersion: taskVersionRef("beads_v1"),
      currentContext: "Leader operation committed.",
      journalEntries: [{ kind: "progress" as const, text: "Leader operation committed." }],
      status: "in_progress" as const,
    };

    await expect(adapter.update(operationA)).resolves.toMatchObject({ kind: "updated", operationId: "operation-a" });
    const parsed = storedMetadata;
    const refreshed = refreshCandidateTaskMetadata(parsed, "Worker metadata refreshed.");
    await update("candidate-task-1", {
      taskId: "candidate-task-1",
      operationId: "worker-refresh",
      expectedVersion: taskVersionRef("beads_v2"),
      currentContext: "Worker metadata refreshed.",
      journalEntries: [],
      status: "in_progress",
    }, refreshed);

    const replay = await adapter.update(operationA);
    expect(replay).toMatchObject({
      kind: "updated",
      operationId: "operation-a",
      task: { version: "beads_v3", current_context: "Worker metadata refreshed." },
      journalEntries: [{ text: "Leader operation committed." }],
    });
    const conflict = await adapter.update({ ...operationA, currentContext: "Conflicting reuse." });
    expect(conflict).toMatchObject({
      kind: "refused",
      reason: "operation_conflict",
      operationId: "operation-a",
      currentTask: { version: "beads_v3" },
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(storedMetadata.last_operation).toMatchObject({ operation_id: "operation-a" });
    expect(storedMetadata.last_operation?.journal_entries).toHaveLength(1);
  });

  it("rejects an oversized leader context before invoking its authority", async () => {
    const update = vi.fn();
    const adapter = new CandidateBeadsTaskAdapter("candidate-team", "team-lead", {
      create: vi.fn(async () => receipt(task())),
      read: vi.fn(async () => authorityRecord(metadata("Ready to update."))),
      update,
    });

    await expect(adapter.update({
      taskId: "candidate-task-1",
      operationId: "context-too-large",
      expectedVersion: taskVersionRef("beads_authority_version"),
      currentContext: "👩🏽‍🚀".repeat(2_001),
    })).rejects.toThrow("2,000 TypeBox string");
    expect(update).not.toHaveBeenCalled();
  });

  it("derives nonterminal Worker work from current assignment and status", () => {
    const current = {
      id: "task-open",
      title: "Open",
      goal: "Open goal",
      status: "open" as const,
      assignee: "verifier",
      current_context: "Open.",
      version: "v1",
    };
    expect(projectCandidateNonterminalTaskIds([
      current,
      { ...current, id: "task-closed", status: "closed" },
      { ...current, id: "task-other", assignee: "other" },
    ], "verifier")).toEqual(["task-open"]);
  });
});

describe("candidate Beads metadata and Team event evidence", () => {
  it("rejects direct candidate metadata writes before any Beads command", async () => {
    const run = vi.fn();
    const store = new BeadsTaskStore({
      teamName: "candidate-store",
      workspace: "/tmp/candidate-store",
      runner: { run } satisfies BdRunner,
    });
    const invalid = metadata("👩🏽‍🚀".repeat(2_001));
    const invalidGoal = { ...metadata(), goal: "😀".repeat(501) };

    await expect(store.create({
      title: "Invalid candidate",
      description: "No Beads write is allowed.",
      internalMetadata: { [CANDIDATE_TASK_METADATA_KEY]: invalid },
    })).rejects.toThrow("2,000 TypeBox string");
    await expect(store.updateWithResult("candidate-task-1", {}, {
      candidateTaskMetadata: invalid,
    })).rejects.toThrow("2,000 TypeBox string");
    await expect(store.create({
      title: "Invalid goal",
      description: "No Beads write is allowed.",
      internalMetadata: { [CANDIDATE_TASK_METADATA_KEY]: invalidGoal },
    })).rejects.toThrow("1,000 TypeBox string");
    expect(run).not.toHaveBeenCalled();
  });

  it("commits current context metadata with status and note in one Beads update command", async () => {
    const before = {
      id: "candidate-task-1",
      title: "Verify candidate",
      description: "compatibility",
      acceptance_criteria: "compatibility",
      status: "open",
      assignee: "verifier",
      labels: ["pi-teams:candidate-store"],
      metadata: {
        pi_teams_team: "candidate-store",
        [CANDIDATE_TASK_METADATA_KEY]: metadata(),
      },
      updated_at: "2026-08-02T00:00:00Z",
      dependencies: [],
      dependents: [],
      comments: [],
    };
    const updatedMetadata = metadata("Verification is blocked by a digest mismatch.");
    const after = {
      ...before,
      status: "blocked",
      notes: "Digest mismatch observed.",
      metadata: {
        ...before.metadata,
        [CANDIDATE_TASK_METADATA_KEY]: JSON.stringify(updatedMetadata),
      },
      updated_at: "2026-08-02T00:00:01Z",
    };
    const responses: unknown[] = [[before], after, [after], [after]];
    const run = vi.fn(async (_args: string[]) => ({ stdout: JSON.stringify(responses.shift()), stderr: "", exitCode: 0 }));
    const store = new BeadsTaskStore({
      teamName: "candidate-store",
      workspace: "/tmp/candidate-store",
      runner: { run } satisfies BdRunner,
      requireExpectedVersion: false,
    });

    const mutation = await store.updateWithResult("candidate-task-1", { status: "blocked" }, {
      actor: "team-lead",
      appendNote: "Digest mismatch observed.",
      candidateTaskMetadata: updatedMetadata,
    });
    const record = await store.readCandidateTaskAuthorityRecord("candidate-task-1");

    const updateArgs = run.mock.calls.map((call) => call[0]).find((args) => args.includes("update"))!;
    expect(updateArgs).toEqual(expect.arrayContaining([
      "--append-notes", "Digest mismatch observed.",
      "--set-metadata", `${CANDIDATE_TASK_METADATA_KEY}=${JSON.stringify(updatedMetadata)}`,
      "--status", "blocked",
    ]));
    expect(mutation.appliedOperations).toEqual([
      "set:status",
      "append:note",
      "set:candidateTaskMetadata",
    ]);
    expect(record.candidateMetadata).toBe(JSON.stringify(updatedMetadata));
    expect(record.task.version).toMatch(/^beads_[a-f0-9]{64}$/);
  });

  it("uses committed Team event identity and time in the updates projection", async () => {
    const teamName = `candidate-events-${process.pid}-${Date.now()}`;
    createdTeams.push(teamName);
    fs.mkdirSync(teamDir(teamName), { recursive: true });
    fs.writeFileSync(configPath(teamName), JSON.stringify({ name: teamName, members: [] }));

    const committed = await appendTaskEvidenceEvent(teamName, {
      type: "task",
      ref: { authorityId: "task-authority", taskId: "candidate-task-1", version: "beads_v2" },
      change: "note",
      actor: "team-lead",
      taskEvidence: { kind: "decision", text: "Keep the Task blocked." },
    });
    const event = readTeamEvents(teamName, { afterCursor: "0" }).events[0];
    const entry = projectCandidateTaskJournalEntry(event);
    const changes = projectCandidateTaskChanges([event], [{
      id: "candidate-task-1",
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      status: "blocked",
      assignee: "verifier",
      current_context: "Digest mismatch requires a leader decision.",
      version: "beads_v2",
    }]);

    expect(entry).toEqual({
      id: `task-event-${committed.cursor}`,
      at: committed.at,
      actor: "team-lead",
      kind: "decision",
      text: "Keep the Task blocked.",
    });
    expect(changes).toEqual({
      kind: "projected",
      changes: [{
        taskId: "candidate-task-1",
        changeKinds: ["progress"],
        journalEntries: [entry],
        current: {
          status: "blocked",
          assignee: "verifier",
          current_context: "Digest mismatch requires a leader decision.",
          version: "beads_v2",
        },
      }],
    });
    expect(projectCandidateTaskChanges([{
      type: "task",
      cursor: "99",
      ref: { authorityId: "task-authority", taskId: "candidate-task-1", version: "beads_v2" },
      change: "status",
      actor: "external",
      at: "2026-08-02T00:00:00.000Z",
    }], [{
      id: "candidate-task-1",
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      status: "blocked",
      current_context: "Current.",
      version: "beads_v2",
    }])).toEqual({
      kind: "projected",
      changes: [{
        taskId: "candidate-task-1",
        changeKinds: ["status"],
        journalEntries: [],
        current: { status: "blocked", current_context: "Current.", version: "beads_v2" },
      }],
    });
    const structural = (["created", "assigned", "status", "relation"] as const).map((change, index) => ({
      type: "task" as const,
      cursor: String(index + 1),
      ref: { authorityId: "task-authority", taskId: "candidate-task-1", version: "beads_v2" },
      change,
      actor: "external",
      at: "2026-08-02T00:00:00.000Z",
    }));
    expect(projectCandidateTaskChanges(structural, [{
      id: "candidate-task-1",
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      status: "blocked",
      current_context: "Current.",
      version: "beads_v2",
    }])).toMatchObject({
      kind: "projected",
      changes: [{ changeKinds: ["created", "assignment", "status", "relation"], journalEntries: [] }],
    });

    expect(projectCandidateTaskChanges([{
      type: "task",
      cursor: "100",
      ref: { authorityId: "task-authority", taskId: "candidate-task-1", version: "beads_v2" },
      change: "note",
      actor: "external",
      at: "2026-08-02T00:00:00.000Z",
    }], [{
      id: "candidate-task-1",
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      status: "blocked",
      current_context: "Current.",
      version: "beads_v2",
    }])).toMatchObject({
      kind: "contract_gap",
      reason: "structured_task_event_evidence_absent",
      eventId: "task-event-100",
    });

    expect(candidateUpdateEventEvidence({
      taskId: "candidate-task-1",
      operationId: "operation-1",
      expectedVersion: taskVersionRef("beads_v2"),
      currentContext: "Next.",
      journalEntries: [{ kind: "result", text: "Verified." }],
    })).toEqual([{ kind: "result", text: "Verified." }]);
  });
});
