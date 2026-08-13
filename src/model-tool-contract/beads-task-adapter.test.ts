import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BeadsTaskStore,
  TASK_METADATA_KEY,
  TASK_METADATA_SCHEMA,
  type BdRunner,
  type TaskAuthorityRecordEnvelope,
  type TaskMetadata,
  type CreateTaskInput,
} from "../utils/beads";
import type { TaskAuthorityRecord } from "../utils/beads";
import { configPath, teamDir } from "../utils/paths";
import {
  appendTaskEvidenceEvent,
  readTeamEvents,
} from "../utils/team-events";
import type { InternalTaskPublicationOptions, TaskCreateReceipt } from "./beads-authority-adapter";
import {
  BeadsTaskAdapter,
  createReadOnlyBeadsTaskAdapterFactory,
  createPublishingBeadsTaskAdapterFactory,
  taskUpdateEventEvidence,
  projectNonterminalTaskIds,
  refreshTaskMetadata,
  projectTaskChanges,
  projectTaskJournalEntry,
  type TaskAdapterAuthority,
} from "./beads-task-adapter";
import { taskVersionRef } from "./task-version-ref";
import { createTaskAuthorityTeamPort } from "../../test/support/task-authority-team-port";

const createdTeams: string[] = [];

function task(overrides: Partial<TaskAuthorityRecord> = {}): TaskAuthorityRecord {
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

function receipt(value: TaskAuthorityRecord): TaskCreateReceipt {
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

function metadata(currentContext = "Work has not started."): TaskMetadata {
  return {
    schema: TASK_METADATA_SCHEMA,
    goal: "Verify the exact release digest.",
    current_context: currentContext,
  };
}

function versionCompleteRaw(id: string) {
  return {
    id,
    title: id,
    description: "",
    acceptance_criteria: "",
    design: "",
    notes: "",
    parent: "",
    status: "open" as const,
    assignee: "",
    updated_at: "2026-08-11T14:00:00.000Z",
    labels: ["pi-teams:candidate-team"],
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    dependencies: [],
    dependents: [],
    metadata: { pi_teams_team: "candidate-team", [TASK_METADATA_KEY]: metadata(id) },
  };
}

function authorityRecord(taskMetadata?: unknown): TaskAuthorityRecordEnvelope {
  return {
    task: task(),
    ...(taskMetadata === undefined ? {} : { taskMetadata }),
  };
}

function completeAuthority(overrides: Record<string, unknown>): TaskAdapterAuthority {
  return {
    mode: "publishing",
    read: async () => authorityRecord(metadata()),
    readMany: async () => [],
    list: async () => [],
    create: async () => receipt(task()),
    update: async () => { throw new Error("unused update"); },
    link: async () => { throw new Error("unused link"); },
    ...overrides,
  } as TaskAdapterAuthority;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(teamDir(teamName), { recursive: true, force: true });
  }
});

describe("durable Task adapter", () => {
  it("keeps explicit read-only construction read-only and exposes mutation only through the publishing factory", async () => {
    const factory = createPublishingBeadsTaskAdapterFactory({
      prepareOwnerTransitionIntent: vi.fn(),
      suppressTaskVersionForSession: vi.fn(),
      publishTaskMutation: vi.fn(),
      completeOwnerTransitionIntent: vi.fn(),
    }, createTaskAuthorityTeamPort(), {
      readTaskAuthorityRecordEnvelope: async () => authorityRecord(metadata()),
      readTaskAuthorityRecordEnvelopes: async () => [],
      listTaskIds: async () => [],
    }, { reconcileReady: vi.fn(async () => []) });
    expect(factory("candidate-team", "team-lead")).toBeInstanceOf(BeadsTaskAdapter);

    const readPort = {
      readTaskAuthorityRecordEnvelope: vi.fn(async () => authorityRecord(metadata())),
      readTaskAuthorityRecordEnvelopes: vi.fn(async () => []),
      listTaskIds: vi.fn(async () => []),
    };
    const explicitReadOnly = createReadOnlyBeadsTaskAdapterFactory(readPort)("candidate-team", "team-lead");
    await expect(explicitReadOnly.create({
      operationId: "read-only-create",
      title: "Must not mutate",
      goal: "Require an injected publication port.",
    })).resolves.toEqual({
      kind: "unknown_outcome",
      operationId: "read-only-create",
      message: "Task create outcome is unknown: the Task adapter is read-only.",
    });
    await expect(explicitReadOnly.list()).resolves.toEqual([]);
    expect(readPort.listTaskIds).toHaveBeenCalledWith("candidate-team");
  });

  it("creates through the existing Task authority and keeps metadata canonical", async () => {
    const create = vi.fn(async (_input: CreateTaskInput, _publication: InternalTaskPublicationOptions) => receipt(task()));
    const read = vi.fn(async () => authorityRecord(metadata()));
    const adapter = new BeadsTaskAdapter("candidate-team", "team-lead", completeAuthority({ create, read }));

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
        [TASK_METADATA_KEY]: metadata(),
      },
    });
    expect(create.mock.calls[0][1]).toEqual({
      taskEventEvidence: [{ kind: "created", text: "Verify the exact release digest." }],
      taskMetadata: metadata(),
      taskCardProjector: expect.any(Function),
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
        relations: [],
        dependency_state: { kind: "ready", active_blocker_ids: [] },
        current_context: "Work has not started.",
        version: taskVersionRef("beads_authority_version"),
      },
      deliveryWarnings: [],
    });
  });

  it("recovers an unknown create outcome only through the same Team-scoped operation", async () => {
    let stored: TaskAuthorityRecordEnvelope | undefined;
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
    const adapter = new BeadsTaskAdapter("candidate-team", "team-lead", completeAuthority({ create, read }));
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
    const authority: TaskAdapterAuthority = completeAuthority({
      create,
      read: vi.fn(async () => records.shift()!),
    });
    const adapter = new BeadsTaskAdapter("candidate-team", "team-lead", authority);

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
      reason: "task_metadata_absent",
      version: taskVersionRef("beads_authority_version"),
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
                [TASK_METADATA_KEY]: metadata(),
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
                ...(id === "candidate-task-1" ? { [TASK_METADATA_KEY]: metadata() } : {}),
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
    const records = await store.readTaskAuthorityRecordEnvelopes(listed.map((candidate) => candidate.id));

    const listCommands = commands.filter((args) => args[3] === "list");
    const showCommands = commands.filter((args) => args[3] === "show");
    expect(listCommands).toHaveLength(2);
    expect(listCommands[0]).toEqual([
      "--directory", "/tmp/candidate-team-authority", "--json",
      "list", "--label", "pi-teams:candidate-team", "--all", "--no-pager", "--limit", "0",
    ]);
    expect(listCommands[1]).toEqual([
      "--directory", "/tmp/candidate-team-authority", "--json",
      "list", "--label", "pi-teams:candidate-team", "--all", "--no-pager", "--limit", "0",
      "--id", ids.join(","),
    ]);
    expect(showCommands).toHaveLength(1);
    expect(showCommands[0]).toEqual([
      "--directory", "/tmp/candidate-team-authority", "--json",
      "show", ...ids, "--include-dependents",
    ]);
    expect(showCommands.filter((args) => ids.filter((id) => args.includes(id)).length === 1)).toHaveLength(0);
    expect(records).toHaveLength(2);
    expect(records[0]!.taskMetadata).toEqual(metadata());
    expect(records[1]).not.toHaveProperty("taskMetadata");
  });

  it("uses one exact native show for mixed missing candidate IDs", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify([{
        id: "candidate-task-1",
        title: "Candidate task",
        description: "Compatibility text",
        acceptance_criteria: "Compatibility text",
        status: "open",
        labels: ["pi-teams:candidate-team"],
        metadata: {
          pi_teams_team: "candidate-team",
          [TASK_METADATA_KEY]: metadata(),
        },
      }]),
      stderr: "Error fetching candidate-task-missing: no issue found matching \"candidate-task-missing\"",
      exitCode: 0,
    }));
    const store = new BeadsTaskStore({ teamName: "candidate-team", workspace: "/tmp/candidate-team-authority", runner: { run } });

    await expect(store.readTaskAuthorityRecordEnvelopes([
      "candidate-task-1", "candidate-task-missing", "candidate-task-1",
    ])).resolves.toMatchObject([
      { task: { id: "candidate-task-1" }, taskMetadata: metadata() },
      undefined,
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith([
      "--directory", "/tmp/candidate-team-authority", "--json",
      "show", "candidate-task-1", "candidate-task-missing", "--include-dependents",
    ], { cwd: "/tmp/candidate-team-authority", timeoutMs: 10_000 });
  });

  it("uses exact metadata filtering for create replay instead of scanning the Team list", async () => {
    const run = vi.fn(async (args: string[]) => {
      expect(args).toEqual([
        "--directory", "/tmp/candidate-team-authority", "--json",
        "list", "--label", "pi-teams:candidate-team", "--all", "--no-pager", "--limit", "0",
        "--metadata-field", "pi_teams_idempotency_key=model-task-create:candidate-team:replay-1",
      ]);
      return {
        stdout: JSON.stringify([{
          id: "candidate-task-1", title: "Candidate", status: "open", labels: ["pi-teams:candidate-team"],
          metadata: { pi_teams_team: "candidate-team", pi_teams_idempotency_key: "model-task-create:candidate-team:replay-1", [TASK_METADATA_KEY]: metadata() },
        }]), stderr: "", exitCode: 0,
      };
    });
    const store = new BeadsTaskStore({ teamName: "candidate-team", workspace: "/tmp/candidate-team-authority", runner: { run } });

    await expect(store.createWithResult({ title: "Candidate", description: "Compatibility", idempotencyKey: "model-task-create:candidate-team:replay-1" })).resolves.toMatchObject({
      replayed: true, task: { id: "candidate-task-1" },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("uses one fast exact-ID list for more than 100 relation-complete Tasks", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `candidate-task-${index + 1}`);
    const run = vi.fn(async (args: string[]) => {
      expect(args[3]).toBe("list");
      const requested = args[args.indexOf("--id") + 1]!.split(",");
      return {
        stdout: JSON.stringify([...requested].reverse().map(versionCompleteRaw)), stderr: "", exitCode: 0,
      };
    });
    const store = new BeadsTaskStore({ teamName: "candidate-team", workspace: "/tmp/candidate-team-authority", runner: { run } });

    const records = await store.readTaskAuthorityRecordEnvelopes(ids);

    expect(run).toHaveBeenCalledOnce();
    expect(records.map((record) => record?.task.id)).toEqual(ids);
  });

  it("falls back to show when list cannot prove relation and authority-version fidelity", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[3] === "list") {
        return {
          stdout: JSON.stringify([{
            id: "candidate-task-1", title: "Candidate", status: "open", labels: ["pi-teams:candidate-team"],
            dependency_count: 1, dependent_count: 1, comment_count: 0,
            metadata: { pi_teams_team: "candidate-team", [TASK_METADATA_KEY]: metadata() },
          }]), stderr: "", exitCode: 0,
        };
      }
      return {
        stdout: JSON.stringify([{
          id: "candidate-task-1", title: "Candidate", status: "open", labels: ["pi-teams:candidate-team"],
          dependency_count: 1, dependent_count: 1, comment_count: 0,
          dependencies: [{ id: "blocker", dependency_type: "blocks" }],
          dependents: [{ id: "related", dependency_type: "related" }],
          metadata: { pi_teams_team: "candidate-team", [TASK_METADATA_KEY]: metadata() },
        }]), stderr: "", exitCode: 0,
      };
    });
    const store = new BeadsTaskStore({ teamName: "candidate-team", workspace: "/tmp/candidate-team-authority", runner: { run } });

    const [record] = await store.readTaskAuthorityRecordEnvelopes(["candidate-task-1"]);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0][3]).toBe("show");
    expect(record?.task).toMatchObject({
      relations: [
        { relation: "blocked_by", targetId: "blocker" },
        { relation: "related", targetId: "related" },
      ],
      version: expect.stringMatching(/^beads_/),
    });
  });

  it("avoids a forced 16-ID show timeout when exact list records prove relation and version fidelity", async () => {
    const ids = Array.from({ length: 16 }, (_, index) => `candidate-task-${index + 1}`);
    const run = vi.fn(async (args: string[]) => {
      if (args[3] === "show") return { stdout: "", stderr: "forced 16-ID timeout", exitCode: 124 };
      const requested = args[args.indexOf("--id") + 1]!.split(",");
      return {
        stdout: JSON.stringify(requested.map(versionCompleteRaw)), stderr: "", exitCode: 0,
      };
    });
    const store = new BeadsTaskStore({ teamName: "candidate-team", workspace: "/tmp/candidate-team-authority", runner: { run } });

    await expect(store.readTaskAuthorityRecordEnvelopes(ids)).resolves.toHaveLength(16);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0][3]).toBe("list");
  });

  it("matches canonical show authority envelope and version when exact list supplies every version input", async () => {
    const raw = {
      ...versionCompleteRaw("candidate-task-1"),
      dependency_count: 1,
      dependent_count: 1,
      dependencies: [{ id: "blocker", dependency_type: "blocks" }],
      dependents: [{ id: "related", dependency_type: "related" }],
    };
    const run = vi.fn(async (_args: string[]) => ({ stdout: JSON.stringify([raw]), stderr: "", exitCode: 0 }));
    const store = new BeadsTaskStore({ teamName: "candidate-team", workspace: "/tmp/candidate-team-authority", runner: { run } });

    const [listed] = await store.readTaskAuthorityRecordEnvelopes([raw.id]);
    const shown = await store.readTaskAuthorityRecordEnvelope(raw.id);

    expect(listed).toEqual(shown);
    expect(listed?.task.version).toEqual(shown.task.version);
    expect(listed?.task.relations).toEqual([
      { relation: "blocked_by", targetId: "blocker" },
      { relation: "related", targetId: "related" },
    ]);
    expect(run.mock.calls.map(([args]) => args[3])).toEqual(["list", "show"]);
  });

  it("splits large hydrations into sequential bounded shows and restores requested order", async () => {
    const ids = Array.from({ length: 33 }, (_, index) => `candidate-task-${index + 1}`);
    const commands: string[][] = [];
    const runner: BdRunner = {
      run: vi.fn(async (args) => {
        commands.push(args);
        const requested = args.slice(4, -1) as string[];
        return {
          stdout: JSON.stringify(requested.map((id) => ({
            id,
            title: id,
            status: "open",
            labels: ["pi-teams:candidate-team"],
            metadata: { pi_teams_team: "candidate-team", [TASK_METADATA_KEY]: metadata(id) },
          })).reverse()),
          stderr: "",
          exitCode: 0,
        };
      }),
    };
    const store = new BeadsTaskStore({ teamName: "candidate-team", workspace: "/tmp/candidate-team-authority", runner });

    const records = await store.readTaskAuthorityRecordEnvelopes([...ids].reverse());
    const showCommands = commands.filter((args) => args[3] === "show");

    expect(showCommands).toHaveLength(9);
    expect(showCommands.map((args) => args.slice(4, -1).length)).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 1]);
    expect(showCommands.flatMap((args) => args.slice(4, -1))).toEqual([...ids].reverse());
    expect(records.map((record) => record?.task.id)).toEqual([...ids].reverse());
  });

  it("preserves a missing value from a later bounded batch", async () => {
    const ids = Array.from({ length: 18 }, (_, index) => `candidate-task-${index + 1}`);
    const raw = (id: string) => ({
      id,
      title: id,
      status: "open" as const,
      labels: ["pi-teams:candidate-team"],
      metadata: { pi_teams_team: "candidate-team", [TASK_METADATA_KEY]: metadata(id) },
    });
    const runner: BdRunner = {
      run: vi.fn(async (args) => {
        const requested = args.slice(4, -1);
        return {
          stdout: JSON.stringify(requested.filter((id: string) => id !== ids[17]).map(raw)),
          stderr: requested.includes(ids[17]) ? "Error fetching candidate-task-18: no issue found matching candidate-task-18" : "",
          exitCode: 0,
        };
      }),
    };
    const store = new BeadsTaskStore({ teamName: "candidate-team", workspace: "/tmp/candidate-team-authority", runner });

    const records = await store.readTaskAuthorityRecordEnvelopes(ids);

    expect(records).toHaveLength(ids.length);
    expect(records.slice(0, 17).map((record) => record?.task.id)).toEqual(ids.slice(0, 17));
    expect(records[17]).toBeUndefined();
    expect(runner.run).toHaveBeenCalledTimes(6);
  });

  it.each([
    ["malformed", { stdout: "{}", stderr: "", exitCode: 0 }],
    ["unrequested", { stdout: JSON.stringify([{ id: "other-task" }]), stderr: "", exitCode: 0 }],
    ["duplicate", { stdout: JSON.stringify([
      { id: "candidate-task-1", title: "Candidate", status: "open", labels: ["pi-teams:candidate-team"], metadata: { pi_teams_team: "candidate-team" } },
      { id: "candidate-task-1", title: "Candidate", status: "open", labels: ["pi-teams:candidate-team"], metadata: { pi_teams_team: "candidate-team" } },
    ]), stderr: "", exitCode: 0 }],
    ["failure", { stdout: "", stderr: "native show failed", exitCode: 1 }],
  ] as const)("propagates a later-batch %s without returning a partial hydration", async (_kind, result) => {
    const ids = Array.from({ length: 17 }, (_, index) => `candidate-task-${index + 1}`);
    const raw = (id: string) => ({
      id,
      title: id,
      status: "open" as const,
      labels: ["pi-teams:candidate-team"],
      metadata: { pi_teams_team: "candidate-team", [TASK_METADATA_KEY]: metadata(id) },
    });
    const runner: BdRunner = {
      run: vi.fn(async (args) => {
        const requested = args.slice(4, -1);
        return requested.includes(ids[16])
          ? result
          : { stdout: JSON.stringify(requested.map(raw)), stderr: "", exitCode: 0 };
      }),
    };
    const store = new BeadsTaskStore({ teamName: "candidate-team", workspace: "/tmp/candidate-team-authority", runner });

    await expect(store.readTaskAuthorityRecordEnvelopes(ids)).rejects.toThrow();
    expect(runner.run).toHaveBeenCalledTimes(6);
  });

  it("projects batched Task records with the same found and gap semantics", async () => {
    const read = vi.fn(async (taskId: string) => authorityRecord(metadata(`${taskId} context`)));
    const readMany = vi.fn(async (taskIds: readonly string[]) => taskIds.map((taskId) => ({
      ...authorityRecord(taskId === "candidate-task-2" ? undefined : metadata(`${taskId} context`)),
      task: task({ id: taskId }),
    })));
    const adapter = new BeadsTaskAdapter("candidate-team", "team-lead", completeAuthority({
      create: vi.fn(async () => receipt(task())),
      read,
      readMany,
    }));

    await expect(adapter.readMany(["candidate-task-1", "candidate-task-2"])).resolves.toMatchObject([
      { kind: "found", task: { id: "candidate-task-1", current_context: "candidate-task-1 context" } },
      { kind: "contract_gap", reason: "task_metadata_absent", taskId: "candidate-task-2" },
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
    const adapter = new BeadsTaskAdapter("candidate-team", "team-lead", completeAuthority({
      create: vi.fn(async () => receipt(task())),
      read: vi.fn(async () => records.shift()!),
    }));

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
        version: taskVersionRef("beads_authority_version"),
      },
    });
    await expect(adapter.read("candidate-task-1")).resolves.toMatchObject({
      kind: "found",
      task: { title: expect.stringContaining("…"), projection_warnings: [{ truncated_fields: ["title"] }] },
    });
  });

  it("returns a typed no-write gap instead of claiming CAS or operation replay", async () => {
    const authority: TaskAdapterAuthority = {
      mode: "read_only",
      read: vi.fn(async () => authorityRecord(metadata("Ready to update."))),
      readMany: vi.fn(async () => []),
      list: vi.fn(async () => []),
    };
    const adapter = new BeadsTaskAdapter("candidate-team", "team-lead", authority);

    await expect(adapter.update({
      taskId: "candidate-task-1",
      operationId: "operation-1",
      expectedVersion: taskVersionRef("beads_authority_version"),
      currentContext: "Update must not commit without CAS.",
      journalEntries: [{ kind: "decision", text: "Refuse the unsafe write." }],
    })).resolves.toMatchObject({
      kind: "contract_gap",
      reason: "external_writer_atomicity_unavailable",
      unsupported: ["atomic_compare_and_swap", "task_scoped_operation_replay"],
      currentTask: { version: taskVersionRef("beads_authority_version") },
    });
  });

  it("commits a candidate update and replays the durable operation record", async () => {
    let stored: TaskMetadata = metadata("Before update.");
    const update = vi.fn(async (_taskId: string, _input: any, nextMetadata: TaskMetadata) => {
      stored = nextMetadata;
      return {
        task: task({ version: "beads_authority_version_next", status: "in_progress" }),
        before: task(),
        appliedOperations: ["set:status", "append:note", "set:taskMetadata"],
        deliveryDegraded: false,
        deliveryWarnings: [],
      };
    });
    const authority: TaskAdapterAuthority = completeAuthority({
      create: vi.fn(async () => receipt(task())),
      read: vi.fn(async () => authorityRecord(stored)),
      update,
    });
    const adapter = new BeadsTaskAdapter("candidate-team", "team-lead", authority);
    const input = {
      taskId: "candidate-task-1",
      operationId: "operation-safe-1",
      expectedVersion: taskVersionRef("beads_authority_version"),
      currentContext: "Worker started.",
      journalEntries: [{ kind: "progress" as const, text: "Worker started." }],
      status: "in_progress" as const,
    };
    const first = await adapter.update(input);
    expect(first).toMatchObject({ kind: "updated", operationId: "operation-safe-1", task: { version: taskVersionRef("beads_authority_version_next") } });
    const replay = await adapter.update(input);
    expect(replay).toMatchObject({ kind: "updated", operationId: "operation-safe-1" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("preserves replay metadata across a Worker context refresh", async () => {
    let storedTask = task({ version: "beads_v1" });
    let storedMetadata: TaskMetadata = metadata("Before update.");
    const update = vi.fn(async (_taskId: string, input: any, nextMetadata: TaskMetadata) => {
      storedMetadata = nextMetadata;
      storedTask = task({
        version: input.operationId === "operation-a" ? "beads_v2" : "beads_v3",
        status: input.status ?? storedTask.status,
      });
      return {
        task: storedTask,
        before: task(),
        appliedOperations: ["set:status", "append:note", "set:taskMetadata"],
        deliveryDegraded: false,
        deliveryWarnings: [],
      };
    });
    const authority: TaskAdapterAuthority = completeAuthority({
      create: vi.fn(async () => receipt(task())),
      read: vi.fn(async () => ({ task: storedTask, taskMetadata: storedMetadata })),
      update,
    });
    const adapter = new BeadsTaskAdapter("candidate-team", "team-lead", authority);
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
    const refreshed = refreshTaskMetadata(parsed, "Worker metadata refreshed.");
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
      task: { version: taskVersionRef("beads_v3"), current_context: "Worker metadata refreshed." },
      journalEntries: [{ text: "Leader operation committed." }],
    });
    const conflict = await adapter.update({ ...operationA, currentContext: "Conflicting reuse." });
    expect(conflict).toMatchObject({
      kind: "refused",
      reason: "operation_conflict",
      operationId: "operation-a",
      currentTask: { version: taskVersionRef("beads_v3") },
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(storedMetadata.last_operation).toMatchObject({ operation_id: "operation-a" });
    expect(storedMetadata.last_operation?.journal_entries).toHaveLength(1);
  });

  it("returns a typed gap for oversized leader context before invoking its authority", async () => {
    const update = vi.fn();
    const adapter = new BeadsTaskAdapter("candidate-team", "team-lead", completeAuthority({
      create: vi.fn(async () => receipt(task())),
      read: vi.fn(async () => authorityRecord(metadata("Ready to update."))),
      update,
    }));

    await expect(adapter.update({
      taskId: "candidate-task-1",
      operationId: "context-too-large",
      expectedVersion: taskVersionRef("beads_authority_version"),
      currentContext: "👩🏽‍🚀".repeat(2_001),
    })).resolves.toMatchObject({
      kind: "contract_gap",
      reason: "task_metadata_invalid",
      taskId: "candidate-task-1",
      version: taskVersionRef("beads_authority_version"),
      message: expect.stringContaining("2,000 TypeBox string"),
    });
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
    expect(projectNonterminalTaskIds([
      current,
      { ...current, id: "task-closed", status: "closed" },
      { ...current, id: "task-other", assignee: "other" },
    ], "verifier")).toEqual(["task-open"]);
  });
});

describe("candidate Beads metadata and Team event evidence", () => {
  it("rejects direct Task metadata writes before any Beads command", async () => {
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
      internalMetadata: { [TASK_METADATA_KEY]: invalid },
    })).rejects.toThrow("2,000 TypeBox string");
    await expect(store.updateWithResult("candidate-task-1", {}, {
      taskMetadata: invalid,
    })).rejects.toThrow("2,000 TypeBox string");
    await expect(store.create({
      title: "Invalid goal",
      description: "No Beads write is allowed.",
      internalMetadata: { [TASK_METADATA_KEY]: invalidGoal },
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
        [TASK_METADATA_KEY]: metadata(),
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
        [TASK_METADATA_KEY]: JSON.stringify(updatedMetadata),
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
      taskMetadata: updatedMetadata,
    });
    const record = await store.readTaskAuthorityRecordEnvelope("candidate-task-1");

    const updateArgs = run.mock.calls.map((call) => call[0]).find((args) => args.includes("update"))!;
    expect(updateArgs).toEqual(expect.arrayContaining([
      "--append-notes", "Digest mismatch observed.",
      "--set-metadata", `${TASK_METADATA_KEY}=${JSON.stringify(updatedMetadata)}`,
      "--status", "blocked",
    ]));
    expect(mutation.appliedOperations).toEqual([
      "set:status",
      "append:note",
      "set:taskMetadata",
    ]);
    expect(record.taskMetadata).toBe(JSON.stringify(updatedMetadata));
    expect(record.task.version).toMatch(/^beads_[a-f0-9]{64}$/);
  });

  it("uses committed Team event identity and time in the updates projection", async () => {
    const teamName = `candidate-events-${process.pid}-${Date.now()}`;
    createdTeams.push(teamName);
    fs.mkdirSync(teamDir(teamName), { recursive: true });
    fs.writeFileSync(configPath(teamName), JSON.stringify({ name: teamName, members: [] }));

    const committed = await appendTaskEvidenceEvent(teamName, {
      type: "task",
      ref: { taskId: "candidate-task-1", version: taskVersionRef("beads_v2") },
      change: "note",
      actor: "team-lead",
      taskEvidence: { kind: "decision", text: "Keep the Task blocked." },
    });
    const event = readTeamEvents(teamName, { afterCursor: "0" }).events[0];
    const entry = projectTaskJournalEntry(event);
    const changes = projectTaskChanges([event], [{
      id: "candidate-task-1",
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      status: "blocked",
      assignee: "verifier",
      current_context: "Digest mismatch requires a leader decision.",
      version: taskVersionRef("beads_v2"),
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
          id: "candidate-task-1",
          title: "Verify candidate",
          goal: "Verify the exact release digest.",
          status: "blocked",
          assignee: "verifier",
          current_context: "Digest mismatch requires a leader decision.",
          version: taskVersionRef("beads_v2"),
        },
      }],
    });
    expect(projectTaskChanges([{
      type: "task",
      cursor: "99",
      ref: { taskId: "candidate-task-1", version: taskVersionRef("beads_v2") },
      change: "status",
      actor: "external",
      at: "2026-08-02T00:00:00.000Z",
    }], [{
      id: "candidate-task-1",
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      status: "blocked",
      current_context: "Current.",
      version: taskVersionRef("beads_v2"),
    }])).toEqual({
      kind: "projected",
      changes: [{
        taskId: "candidate-task-1",
        changeKinds: ["status"],
        journalEntries: [],
        current: { id: "candidate-task-1", title: "Verify candidate", goal: "Verify the exact release digest.", status: "blocked", current_context: "Current.", version: taskVersionRef("beads_v2") },
      }],
    });
    const structural = (["created", "assigned", "status", "relation"] as const).map((change, index) => ({
      type: "task" as const,
      cursor: String(index + 1),
      ref: { taskId: "candidate-task-1", version: taskVersionRef("beads_v2") },
      change,
      actor: "external",
      at: "2026-08-02T00:00:00.000Z",
    }));
    expect(projectTaskChanges(structural, [{
      id: "candidate-task-1",
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      status: "blocked",
      current_context: "Current.",
      version: taskVersionRef("beads_v2"),
    }])).toMatchObject({
      kind: "projected",
      changes: [{ changeKinds: ["created", "assignment", "status", "relation"], journalEntries: [] }],
    });

    expect(projectTaskChanges([{
      type: "task",
      cursor: "100",
      ref: { taskId: "candidate-task-1", version: taskVersionRef("beads_v2") },
      change: "note",
      actor: "external",
      at: "2026-08-02T00:00:00.000Z",
    }], [{
      id: "candidate-task-1",
      title: "Verify candidate",
      goal: "Verify the exact release digest.",
      status: "blocked",
      current_context: "Current.",
      version: taskVersionRef("beads_v2"),
    }])).toMatchObject({
      kind: "contract_gap",
      reason: "structured_task_event_evidence_absent",
      eventId: "task-event-100",
    });

    expect(taskUpdateEventEvidence({
      taskId: "candidate-task-1",
      operationId: "operation-1",
      expectedVersion: taskVersionRef("beads_v2"),
      currentContext: "Next.",
      journalEntries: [{ kind: "result", text: "Verified." }],
    })).toEqual([{ kind: "result", text: "Verified." }]);
  });
});
