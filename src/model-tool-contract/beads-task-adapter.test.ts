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
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      assignee: "verifier",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      title: "Verify candidate",
      description: "Verify the exact release digest.",
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
      id: "candidate-task-1",
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      status: "open",
      assignee: "verifier",
      current_context: "Work has not started.",
      version: "beads_authority_version",
    });
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

  it("returns a typed no-write gap instead of claiming CAS or operation replay", async () => {
    const authority: CandidateTaskAdapterAuthority = {
      create: vi.fn(async () => receipt(task())),
      read: vi.fn(async () => authorityRecord(metadata("Ready to update."))),
    };
    const adapter = new CandidateBeadsTaskAdapter("candidate-team", "team-lead", authority);

    await expect(adapter.update({
      taskId: "candidate-task-1",
      operationId: "operation-1",
      expectedVersion: "beads_authority_version",
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
      expectedVersion: "beads_authority_version",
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
      expectedVersion: "beads_v1",
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
      expectedVersion: "beads_v2",
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
      eventId: "task-event-99",
    });
    expect(candidateUpdateEventEvidence({
      taskId: "candidate-task-1",
      operationId: "operation-1",
      expectedVersion: "beads_v2",
      currentContext: "Next.",
      journalEntries: [{ kind: "result", text: "Verified." }],
    })).toEqual([{ kind: "result", text: "Verified." }]);
  });
});
