import { Type } from "typebox";
import { TeamPaneLayoutSchema } from "../utils/team-pane-layout";
import { TaskVersionRefSchema, taskVersionRef } from "./task-version-ref";
import {
  TASK_CARD_CONTEXT_MAX_LENGTH,
  TASK_CARD_GOAL_MAX_LENGTH,
  TASK_CARD_TITLE_MAX_LENGTH,
  TaskCardContextSchema,
  TaskCardSchema,
  TaskCardWarningSchema,
} from "./task-domain";

/**
 * Model-facing contract shaped in
 * docs/projects/model-invoked-tool-contract.md.
 *
 * This catalog is proposal authority only. It is not registered with Pi until
 * an accepted vertical slice imports the same catalog entry.
 */

export const MODEL_TOOL_LIMITS = {
  maxTaskTitleChars: TASK_CARD_TITLE_MAX_LENGTH,
  maxTaskGoalChars: TASK_CARD_GOAL_MAX_LENGTH,
  maxTaskCurrentContextChars: TASK_CARD_CONTEXT_MAX_LENGTH,
} as const;

const TaskId = Type.String({ minLength: 1, maxLength: 128 });
export { TaskVersionRefSchema } from "./task-version-ref";
const WorkerName = Type.String({ minLength: 1, maxLength: 64 });
const Timestamp = Type.String({ minLength: 1, maxLength: 64 });
const TaskStatus = Type.Enum(["open", "in_progress", "blocked", "closed"], {
  description: "Authoritative Task workflow state.",
});
const WorkerCarrier = Type.Enum(["starting", "connected", "absent"], {
  description: "Current carrier observation. It is not Task progress or readiness.",
});

const TeamCurrent = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  purpose: Type.String({ minLength: 1 }),
  lifecycle: Type.Enum(["active", "stopped"]),
}, { additionalProperties: false });

export const WorkerCurrentSchema = Type.Object({
  name: WorkerName,
  scope: Type.String({ minLength: 1, description: "Concise semantic area owned by this Worker, not its current Task." }),
  carrier: WorkerCarrier,
  nonterminal_task_ids: Type.Array(TaskId),
}, { additionalProperties: false });

const TaskCreateItemSchema = Type.Object({
  operation_id: Type.String({ minLength: 1, maxLength: 128, description: "Opaque caller-chosen create operation identity. Reuse it only to reconcile an unknown create outcome." }),
  title: Type.String({ minLength: 1, maxLength: MODEL_TOOL_LIMITS.maxTaskTitleChars }),
  goal: Type.String({ minLength: 1, maxLength: MODEL_TOOL_LIMITS.maxTaskGoalChars, description: "Desired outcome, relevant boundary, and external success signal in one field." }),
  assignee: Type.Optional(WorkerName),
}, { additionalProperties: false });

export const TaskCreateParametersSchema = Type.Object({
  tasks: Type.Array(TaskCreateItemSchema, { minItems: 1 }),
}, {
  additionalProperties: false,
  description: "Create independent assigned Task work contracts in input order. Each item commits separately.",
});

const TaskCreateOutcomeBase = {
  input_index: Type.Integer({ minimum: 0 }),
  operation_id: Type.String({ minLength: 1, maxLength: 128 }),
};

export const TaskCreateResultSchema = Type.Object({
  kind: Type.Literal("task_create_batch"),
  outcomes: Type.Array(Type.Union([
    Type.Object({
      ...TaskCreateOutcomeBase,
      kind: Type.Literal("created"),
      task: TaskCardSchema,
      delivery_warnings: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }, { additionalProperties: false }),
    Type.Object({
      ...TaskCreateOutcomeBase,
      kind: Type.Literal("refused"),
      reason: Type.Enum(["worker_unavailable", "operation_conflict"]),
      message: Type.String({ minLength: 1 }),
      state_changed: Type.Literal(false),
    }, { additionalProperties: false }),
    Type.Object({
      ...TaskCreateOutcomeBase,
      kind: Type.Literal("unknown_outcome"),
      message: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    Type.Object({
      ...TaskCreateOutcomeBase,
      kind: Type.Literal("unavailable"),
      reason: Type.Enum(["no_active_team", "task_authority_unavailable"]),
      message: Type.String({ minLength: 1 }),
      state_changed: Type.Literal(false),
    }, { additionalProperties: false }),
  ])),
}, {
  additionalProperties: false,
  description: "Independent ordered outcomes. A batch is not atomic.",
});

export const TaskReadParametersSchema = Type.Object({
  task_ids: Type.Array(TaskId, { minItems: 1 }),
}, {
  additionalProperties: false,
  description: "Read current Task cards by ID without changing Team or observation state.",
});

const TaskReadFoundSchema = Type.Object({
  kind: Type.Literal("found"),
  input_index: Type.Integer({ minimum: 0 }),
  task_id: TaskId,
  task: TaskCardSchema,
}, { additionalProperties: false });

const TaskReadMissingSchema = Type.Object({
  kind: Type.Literal("missing"),
  input_index: Type.Integer({ minimum: 0 }),
  task_id: TaskId,
  reason: Type.Literal("task_not_found"),
  state_changed: Type.Literal(false),
}, { additionalProperties: false });

const TaskReadContractGapSchema = Type.Object({
  kind: Type.Literal("contract_gap"),
  input_index: Type.Integer({ minimum: 0 }),
  task_id: TaskId,
  reason: Type.Enum(["task_metadata_absent", "task_metadata_invalid"]),
  version: TaskVersionRefSchema,
  message: Type.String({ minLength: 1 }),
  projection_warning: Type.Optional(TaskCardWarningSchema),
  state_changed: Type.Literal(false),
}, { additionalProperties: false });

export const TaskReadResultSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("task_read_batch"),
    outcomes: Type.Array(Type.Union([TaskReadFoundSchema, TaskReadMissingSchema, TaskReadContractGapSchema])),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("unavailable"),
    reason: Type.Enum(["no_active_team", "task_authority_unavailable"]),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
]);

const TaskUpdateJournalEntrySchema = Type.Object({
  kind: Type.Enum(["progress", "decision", "blocker", "result", "note"]),
  text: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const TaskUpdateItemSchema = Type.Object({
  task_id: TaskId,
  operation_id: Type.String({ minLength: 1, maxLength: 128 }),
  expected_version: TaskVersionRefSchema,
  current_context: Type.Optional(TaskCardContextSchema),
  journal_entries: Type.Optional(Type.Array(TaskUpdateJournalEntrySchema, { minItems: 1 })),
  status: Type.Optional(TaskStatus),
}, { additionalProperties: false, minProperties: 4 });

export const TaskUpdateParametersSchema = Type.Object({
  updates: Type.Array(TaskUpdateItemSchema, { minItems: 1 }),
}, {
  additionalProperties: false,
  description: "Apply one or more supplied Task changes. Omit current_context when it remains relevant; omit journal_entries when no evidence or rationale changes.",
});

export const TaskJournalEntrySchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  at: Timestamp,
  actor: Type.String({ minLength: 1, maxLength: 64 }),
  kind: Type.Enum(["progress", "decision", "blocker", "result", "note"]),
  text: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const TaskUpdateOutcomeBase = {
  input_index: Type.Integer({ minimum: 0 }),
  task_id: TaskId,
  operation_id: Type.String({ minLength: 1, maxLength: 128 }),
};

export const TaskUpdateResultSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("task_update_batch"),
    outcomes: Type.Array(Type.Union([
      Type.Object({
        ...TaskUpdateOutcomeBase,
        kind: Type.Literal("updated"),
        task: TaskCardSchema,
        journal_entries: Type.Array(TaskJournalEntrySchema),
        delivery_warnings: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      }, { additionalProperties: false }),
      Type.Object({
        ...TaskUpdateOutcomeBase,
        kind: Type.Literal("refused"),
        reason: Type.Enum(["task_not_found", "version_conflict", "operation_conflict", "terminal_evidence_required"]),
        message: Type.String({ minLength: 1 }),
        current_task: Type.Optional(TaskCardSchema),
        state_changed: Type.Literal(false),
      }, { additionalProperties: false }),
      Type.Object({
        ...TaskUpdateOutcomeBase,
        kind: Type.Literal("contract_gap"),
        reason: Type.Enum(["task_metadata_absent", "task_metadata_invalid", "external_writer_atomicity_unavailable"]),
        current_task: Type.Optional(TaskCardSchema),
        unsupported: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        message: Type.String({ minLength: 1 }),
        state_changed: Type.Literal(false),
      }, { additionalProperties: false }),
      Type.Object({
        ...TaskUpdateOutcomeBase,
        kind: Type.Literal("unavailable"),
        reason: Type.Enum(["no_active_team", "task_authority_unavailable"]),
        message: Type.String({ minLength: 1 }),
        state_changed: Type.Literal(false),
      }, { additionalProperties: false }),
    ])),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("refused"),
    reason: Type.Literal("duplicate_task_id"),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("unavailable"),
    reason: Type.Literal("no_active_team"),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
]);

export const TaskDeltaSchema = Type.Object({
  task_id: TaskId,
  change_kinds: Type.Array(Type.Enum(["created", "goal", "assignment", "progress", "status", "relation"]), {
    minItems: 1,
    uniqueItems: true,
  }),
  journal_entries: Type.Array(TaskJournalEntrySchema),
  current: TaskCardSchema,
}, { additionalProperties: false, description: "All new Task journal entries grouped with the latest current state." });

export const TeamDeltaSchema = Type.Object({
  kind: Type.Enum(["created", "lifecycle", "purpose"]),
  text: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const WorkerDeltaSchema = Type.Object({
  worker: WorkerName,
  scope: Type.String({ minLength: 1 }),
  kind: Type.Enum(["created", "connected", "stopped", "failed", "scope_changed"]),
  text: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const AlertDeltaSchema = Type.Object({
  alert_id: Type.String({ minLength: 1, maxLength: 128 }),
  from: Type.String({ minLength: 1, maxLength: 64 }),
  kind: Type.Enum(["clarification", "attention", "announcement"]),
  task_id: Type.Optional(TaskId),
  text: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const TeamCreateParametersSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  purpose: Type.String({ minLength: 1, description: "The long-lived Team outcome and operating boundary." }),
  pane_layout: Type.Optional(TeamPaneLayoutSchema),
}, {
  additionalProperties: false,
  description: "Create one long-lived Team and bind the exact calling Session as its leader.",
});

export const TeamCreateResultSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("team_created"),
    team: TeamCurrent,
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("refused"),
    reason: Type.Enum(["active_team_exists", "name_unavailable"]),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("unavailable"),
    reason: Type.Enum(["team_authority_unavailable", "session_binding_unavailable", "task_authority_unavailable", "carrier_unavailable"]),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
]);

export const TeamSyncParametersSchema = Type.Object({
  view: Type.Enum(["snapshot", "updates"], {
    description: "Use snapshot to restore current context; use updates for routine supervision and waiting.",
  }),
}, {
  additionalProperties: false,
  description: "Read the active Team's snapshot or incremental updates. Team identity is resolved from the exact leader Session binding.",
});

export const TeamSnapshotResultSchema = Type.Object({
  kind: Type.Literal("snapshot"),
  team: TeamCurrent,
  workers: Type.Array(WorkerCurrentSchema),
  tasks: Type.Array(TaskCardSchema),
  task_projection_warnings: Type.Optional(Type.Array(TaskCardWarningSchema)),
}, { additionalProperties: false });

export const TeamUpdatesResultSchema = Type.Object({
  kind: Type.Literal("updates"),
  team_changes: Type.Array(TeamDeltaSchema),
  worker_changes: Type.Array(WorkerDeltaSchema),
  task_changes: Type.Array(TaskDeltaSchema),
  alerts: Type.Array(AlertDeltaSchema),
  task_projection_warnings: Type.Optional(Type.Array(TaskCardWarningSchema)),
}, { additionalProperties: false });

export const TeamSyncUnavailableResultSchema = Type.Object({
  kind: Type.Literal("unavailable"),
  reason: Type.Enum(["no_active_team", "team_state_unavailable", "task_authority_unavailable"]),
  message: Type.String({ minLength: 1 }),
  state_changed: Type.Literal(false),
  observation_advanced: Type.Literal(false),
}, { additionalProperties: false });

export const TeamSyncSnapshotRequiredResultSchema = Type.Object({
  kind: Type.Literal("snapshot_required"),
  message: Type.String({ minLength: 1 }),
  state_changed: Type.Literal(false),
  observation_advanced: Type.Literal(false),
}, { additionalProperties: false });

export const TeamSyncCancelledResultSchema = Type.Object({
  kind: Type.Literal("cancelled"),
  message: Type.String({ minLength: 1 }),
  state_changed: Type.Literal(false),
  observation_advanced: Type.Literal(false),
}, { additionalProperties: false });

export const TeamSyncContractGapResultSchema = Type.Object({
  kind: Type.Literal("contract_gap"),
  reason: Type.Enum(["team_epoch_missing", "logical_workers_missing", "task_metadata_absent", "task_metadata_invalid", "structured_task_event_evidence_absent"]),
  message: Type.String({ minLength: 1 }),
  state_changed: Type.Literal(false),
  observation_advanced: Type.Literal(false),
}, { additionalProperties: false });

export const TeamSyncResultSchema = Type.Union([
  TeamSnapshotResultSchema,
  TeamUpdatesResultSchema,
  TeamSyncSnapshotRequiredResultSchema,
  TeamSyncCancelledResultSchema,
  TeamSyncContractGapResultSchema,
  TeamSyncUnavailableResultSchema,
]);

export const EnsureWorkerParametersSchema = Type.Object({
  name: WorkerName,
  scope: Type.String({
    minLength: 1,
    description: "A semantically deep area with high internal cohesion, low prerequisite overlap, and few dependencies on other Workers.",
  }),
}, {
  additionalProperties: false,
  description: "Create, reconnect, or reuse one Worker in the active Team. Work is assigned separately through Tasks.",
});

const EnsuredWorker = Type.Object({
  name: WorkerName,
  scope: Type.String({ minLength: 1 }),
  carrier: WorkerCarrier,
}, { additionalProperties: false });

export const EnsureWorkerResultSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("worker_ensured"),
    effect: Type.Enum(["created", "reused", "reconnected"]),
    worker: EnsuredWorker,
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("refused"),
    reason: Type.Literal("name_scope_conflict"),
    existing_worker: EnsuredWorker,
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("unavailable"),
    reason: Type.Enum(["no_active_team", "carrier_unavailable", "team_authority_unavailable"]),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
]);

export const WorkerStopParametersSchema = Type.Object({
  worker: WorkerName,
}, {
  additionalProperties: false,
  description: "Stop one Worker after its nonterminal Tasks are resolved and exact terminal stop evidence is available.",
});

export const WorkerStopResultSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("worker_stopped"),
    worker: WorkerName,
    state_changed: Type.Literal(true),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("refused"),
    reason: Type.Enum(["worker_not_found", "nonterminal_tasks_assigned", "stop_not_confirmed", "leader_reserved"]),
    worker: WorkerName,
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
    guarding_task_ids: Type.Optional(Type.Array(TaskId)),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("unavailable"),
    reason: Type.Enum(["no_active_team", "team_authority_unavailable", "carrier_unavailable"]),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
]);

export const TeamShutdownParametersSchema = Type.Object({}, {
  additionalProperties: false,
  description: "Stop every Worker and close the exact leader Team. Failed stops keep the Team active for retry.",
});

export const TeamShutdownResultSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("team_shutdown"),
    lifecycle: Type.Literal("stopped"),
    stopped_workers: Type.Array(WorkerName),
    unfinished_task_ids: Type.Array(TaskId),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("partial"),
    lifecycle: Type.Literal("active"),
    stopped_workers: Type.Array(WorkerName),
    failed_workers: Type.Array(WorkerName),
    unfinished_task_ids: Type.Array(TaskId),
    state_changed: Type.Literal(true),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("unavailable"),
    reason: Type.Enum(["no_active_team", "team_authority_unavailable"]),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
]);

export const TaskLinkParametersSchema = Type.Object({
  task_id: TaskId,
  relation: Type.Enum(["blocked_by", "parent", "related"]),
  target_id: TaskId,
  action: Type.Enum(["add", "remove"]),
  expected_version: Type.Optional(TaskVersionRefSchema),
}, {
  additionalProperties: false,
  description: "Add or remove one typed Task relation with graph and version validation. Closed Tasks can still receive relation or evidence writes, so use the latest receipt or read before another conditional mutation.",
});

export const TaskLinkResultSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("task_linked"),
    task_id: TaskId,
    target_id: TaskId,
    relation: Type.Enum(["blocked_by", "parent", "related"]),
    action: Type.Enum(["add", "remove"]),
    changed: Type.Boolean(),
    version: TaskVersionRefSchema,
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("refused"),
    task_id: TaskId,
    reason: Type.Enum(["task_not_found", "version_conflict", "graph_conflict"]),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("unavailable"),
    reason: Type.Enum(["no_active_team", "task_authority_unavailable"]),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
]);

const AlertFields = {
  text: Type.String({ minLength: 1 }),
  task_id: Type.Optional(TaskId),
  task_version: Type.Optional(TaskVersionRefSchema),
};

export const AlertSendParametersSchema = Type.Union([
  Type.Object({
    target: Type.Object({ kind: Type.Literal("worker"), name: WorkerName }, { additionalProperties: false }),
    kind: Type.Enum(["clarification", "attention"]),
    ...AlertFields,
  }, { additionalProperties: false }),
  Type.Object({
    target: Type.Object({ kind: Type.Literal("team") }, { additionalProperties: false }),
    kind: Type.Literal("announcement"),
    ...AlertFields,
  }, { additionalProperties: false }),
], {
  description: "Send exceptional clarification, attention, or announcement. Team targets are valid only for announcements; Worker targets are valid for clarification and attention. An Alert never changes Task state.",
});

export const AlertSendResultSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("alert_sent"),
    alert_id: Type.String({ minLength: 1, maxLength: 128 }),
    accepted_recipients: Type.Array(WorkerName),
    failed_recipients: Type.Array(WorkerName),
    task_state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("refused"),
    reason: Type.Enum(["recipient_not_current", "no_eligible_recipients", "invalid_fanout"]),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("unavailable"),
    reason: Type.Enum(["no_active_team", "team_authority_unavailable"]),
    message: Type.String({ minLength: 1 }),
    state_changed: Type.Literal(false),
  }, { additionalProperties: false }),
]);

const createTeamCall = {
  name: "release-team",
  purpose: "Prepare and verify the public release.",
} as const;
const createdTeamResult = {
  kind: "team_created",
  team: { name: "release-team", purpose: "Prepare and verify the public release.", lifecycle: "active" },
} as const;
const snapshotCall = { view: "snapshot" } as const;
const updatesCall = { view: "updates" } as const;
const ensureWorkerCall = {
  name: "release-verifier",
  scope: "Own independent release verification: clean install, exported surface, provenance, and publication evidence.",
} as const;
const taskCreateCall = {
  tasks: [{
    operation_id: "create-release-candidate",
    title: "Verify release candidate",
    goal: "Confirm the candidate installs cleanly, preserve the exact digest boundary, and report the external verification signal.",
    assignee: "release-verifier",
  }],
} as const;
const taskCreateResult = {
  kind: "task_create_batch",
  outcomes: [{
    kind: "created",
    input_index: 0,
    operation_id: "create-release-candidate",
    task: {
      id: "task-23",
      title: "Verify release candidate",
      goal: "Confirm the candidate installs cleanly, preserve the exact digest boundary, and report the external verification signal.",
      status: "open",
      assignee: "release-verifier",
      current_context: "Work has not started.",
      version: taskVersionRef("task_v1"),
    },
  }],
} as const;
const taskCreateRefusedResult = {
  kind: "task_create_batch",
  outcomes: [{
    kind: "refused",
    input_index: 0,
    operation_id: "create-release-candidate",
    reason: "worker_unavailable",
    message: "The assigned Worker is not present in the active Team.",
    state_changed: false,
  }],
} as const;

const ensuredWorkerResult = {
  kind: "worker_ensured",
  effect: "created",
  worker: {
    name: "release-verifier",
    scope: "Own independent release verification: clean install, exported surface, provenance, and publication evidence.",
    carrier: "connected",
  },
} as const;

const refusedWorkerResult = {
  kind: "refused",
  reason: "name_scope_conflict",
  existing_worker: {
    name: "release-verifier",
    scope: "Own release-note review and public documentation verification.",
    carrier: "connected",
  },
  state_changed: false,
} as const;

const unavailableWorkerResult = {
  kind: "unavailable",
  reason: "no_active_team",
  message: "The exact leader Session is not bound to an active Team.",
  state_changed: false,
} as const;

const snapshotResult = {
  kind: "snapshot",
  team: { name: "release-team", purpose: "Prepare and verify the public release.", lifecycle: "active" },
  workers: [
    {
      name: "release-builder",
      scope: "Own candidate construction, package metadata, and publication dry runs.",
      carrier: "connected",
      nonterminal_task_ids: ["task-17"],
    },
    {
      name: "release-verifier",
      scope: "Own independent release verification: clean install, exported surface, provenance, and publication evidence.",
      carrier: "connected",
      nonterminal_task_ids: ["task-23"],
    },
  ],
  tasks: [
    {
      id: "task-17",
      title: "Prepare release candidate",
      goal: "Produce an installable candidate package with a verified dry-run publication receipt.",
      status: "in_progress",
      assignee: "release-builder",
      current_context: "Package is built. Dry-run publication is next; no blocker is known.",
      version: taskVersionRef("task_v7"),
    },
    {
      id: "task-23",
      title: "Verify release candidate",
      goal: "Independently verify clean install, public exports, and provenance for the exact candidate digest.",
      status: "open",
      assignee: "release-verifier",
      current_context: "Waiting for the candidate digest from task-17.",
      version: taskVersionRef("task_v2"),
    },
  ],
} as const;

const updatesResult = {
  kind: "updates",
  team_changes: [],
  worker_changes: [],
  task_changes: [
    {
      task_id: "task-17",
      change_kinds: ["status", "progress"],
      journal_entries: [
        {
          id: "journal-91",
          at: "2026-08-02T10:00:00Z",
          actor: "release-builder",
          kind: "result",
          text: "Candidate built; clean install passed. Digest sent to release-verifier.",
        },
      ],
      current: {
        id: "task-17",
        title: "Build release candidate",
        goal: "Build and verify the release candidate.",
        status: "closed",
        assignee: "release-builder",
        current_context: "Candidate delivered and verified locally. No further action remains.",
        version: taskVersionRef("task_v8"),
      },
    },
    {
      task_id: "task-23",
      change_kinds: ["status", "progress"],
      journal_entries: [
        {
          id: "journal-92",
          at: "2026-08-02T10:01:00Z",
          actor: "release-verifier",
          kind: "blocker",
          text: "Provenance digest differs from the candidate package digest.",
        },
      ],
      current: {
        id: "task-23",
        title: "Verify release provenance",
        goal: "Verify the release provenance digest.",
        status: "blocked",
        assignee: "release-verifier",
        current_context: "Verification is blocked by a digest mismatch. Leader must choose rebuild or provenance correction.",
        version: taskVersionRef("task_v3"),
      },
    },
  ],
  alerts: [],
} as const;

const unavailableResult = {
  kind: "unavailable",
  reason: "task_authority_unavailable",
  message: "Task authority could not supply the complete snapshot. No Team observation was published.",
  state_changed: false,
  observation_advanced: false,
} as const;

const taskReadCall = {
  task_ids: ["task-23"],
} as const;
const taskReadResult = {
  kind: "task_read_batch",
  outcomes: [{
    kind: "found",
    input_index: 0,
    task_id: "task-23",
    task: taskCreateResult.outcomes[0].task,
  }],
} as const;
const taskReadMissingResult = {
  kind: "task_read_batch",
  outcomes: [{
    kind: "missing",
    input_index: 0,
    task_id: "task-missing",
    reason: "task_not_found",
    state_changed: false,
  }],
} as const;
const taskReadUnavailableResult = {
  kind: "unavailable",
  reason: "no_active_team",
  message: "The exact leader Session is not bound to an active Team.",
  state_changed: false,
} as const;
const taskUpdateCall = {
  updates: [{
    task_id: "task-23",
    operation_id: "verify-release-1",
    expected_version: "v_3680fa021836b49f",
    current_context: "Task is assigned but awaits a Worker carrier.",
    journal_entries: [{ kind: "decision", text: "Keep the Task open until a Worker carrier is available." }],
  }],
} as const;
const taskUpdateResult = {
  kind: "task_update_batch",
  outcomes: [{
    kind: "updated",
    input_index: 0,
    task_id: "task-23",
    operation_id: "verify-release-1",
    task: {
      ...taskCreateResult.outcomes[0].task,
      current_context: "Task is assigned but awaits a Worker carrier.",
      version: taskVersionRef("task_v2"),
    },
    journal_entries: [{
      id: "journal-task-23-1",
      at: "2026-08-02T00:00:00.000Z",
      actor: "leader",
      kind: "decision",
      text: "Keep the Task open until a Worker carrier is available.",
    }],
  }],
} as const;
const taskUpdateConflictResult = {
  kind: "task_update_batch",
  outcomes: [{
    kind: "refused",
    input_index: 0,
    task_id: "task-23",
    operation_id: "verify-release-1",
    reason: "version_conflict",
    message: "The Task version does not match the expected version.",
    current_task: taskCreateResult.outcomes[0].task,
    state_changed: false,
  }],
} as const;

export const modelToolCatalog = {
  schema: "pi-team-bright-model-tool-catalog/1",
  status: "candidate",
  sourceDocument: "docs/projects/model-invoked-tool-contract.md",
  modelResultProjection: {
    status: "accepted",
    version: "2",
    responsibility: "Validate raw semantic truth once, then derive decision-relevant model JSON and allowlisted human projections.",
    boundary: "The raw result remains machine truth; model and human projections cannot add facts or change outcomes.",
  },
  tools: [
    {
      name: "team_create",
      label: "Create Team",
      responsibility: "Create one long-lived Team and bind the exact calling Session as its leader.",
      actors: ["unbound leader"],
      commonUseCases: [
        "Start the first Team for a durable coordination purpose.",
        "Establish the leader binding used by later leader-only calls.",
      ],
      whenNotToUse: [
        "Do not create another Team while the exact Session already leads an active Team.",
        "Do not put carrier placement, Task-backend, or terminal configuration in the Team purpose.",
      ],
      sideEffects: [
        "Creates one logical Team and one exact leader Session binding.",
        "Does not create Workers, Tasks, or Alerts.",
        "Refusal or unavailable authority changes no state.",
      ],
      parameters: TeamCreateParametersSchema,
      result: TeamCreateResultSchema,
      examples: [
        { id: "create-team", title: "Create and lead a long-lived Team", call: createTeamCall, result: createdTeamResult },
      ],
    },
    {
      name: "task_create",
      label: "Create Tasks",
      responsibility: "Create independent executable Task contracts and assign each one to an existing Worker.",
      actors: ["leader"],
      commonUseCases: [
        "Create one or more concrete work contracts after Worker areas exist.",
        "Bind each Task to an existing Worker without claiming carrier readiness.",
      ],
      whenNotToUse: [
        "Do not include Team, backend, paging, relation, read, or update controls.",
        "Do not create a Task for a Worker that is not in the active Team.",
      ],
      sideEffects: [
        "Commits each input item independently in input order.",
        "Creates open Tasks with current_context set to Work has not started.",
        "A refused or unavailable item changes no state.",
      ],
      parameters: TaskCreateParametersSchema,
      result: TaskCreateResultSchema,
      examples: [
        { id: "create-task", title: "Assign one verification Task", call: taskCreateCall, result: taskCreateResult },
        { id: "task-worker-unavailable", title: "Refuse a missing Worker", call: taskCreateCall, result: taskCreateRefusedResult },
      ],
    },
    {
      name: "task_read",
      label: "Read Tasks",
      responsibility: "Read current Task cards by ID without changing Team or observation state.",
      actors: ["leader"],
      commonUseCases: [
        "Recover current definitions and state for selected Task IDs.",
        "Confirm a mutation receipt or inspect a Task before choosing the next action.",
      ],
      whenNotToUse: [
        "Do not request journal history, updates, paging, filters, or Team locators.",
        "Do not use it as a replacement for team_sync observation.",
      ],
      sideEffects: [
        "Returns one ordered found or missing outcome per input occurrence.",
        "Returns one unavailable result without partial Task cards when authority cannot provide a coherent read.",
        "Changes no Team, Task, or observation state.",
      ],
      parameters: TaskReadParametersSchema,
      result: TaskReadResultSchema,
      examples: [
        { id: "read-task", title: "Read one current Task", call: taskReadCall, result: taskReadResult },
        { id: "read-missing-task", title: "Report a missing Task", call: { task_ids: ["task-missing"] }, result: taskReadMissingResult },
        { id: "read-unavailable", title: "No active Team", call: taskReadCall, result: taskReadUnavailableResult },
      ],
    },
    {
      name: "task_update",
      label: "Update Tasks",
      responsibility: "Replace one Task's current context and append leader decision evidence with an expected-version check.",
      actors: ["leader"],
      commonUseCases: [
        "Record a coordination decision and current context for an assigned Task.",
        "Keep a Task open while its assigned Worker awaits a carrier.",
      ],
      whenNotToUse: [
        "Do not change assignment, relations, or Worker state.",
        "Do not use it to read history or observe Team updates.",
      ],
      sideEffects: [
        "Commits current context and generated journal provenance atomically per item.",
        "Rejects duplicate Task IDs before mutation and refuses version or operation conflicts.",
        "Does not claim Worker execution or carrier readiness.",
      ],
      parameters: TaskUpdateParametersSchema,
      result: TaskUpdateResultSchema,
      examples: [
        { id: "update-task", title: "Record a coordination decision", call: taskUpdateCall, result: taskUpdateResult },
        { id: "update-conflict", title: "Refuse a stale version", call: taskUpdateCall, result: taskUpdateConflictResult },
      ],
    },
    {
      name: "team_sync",
      label: "Sync Team",
      responsibility: "Restore current whole-Team context or observe incremental coordination changes.",
      actors: ["leader"],
      commonUseCases: [
        "Restore current Team context after startup or compaction.",
        "Receive changes since the exact Session branch's last completed observation.",
        "Wait for the next Team change when no unseen update exists.",
      ],
      whenNotToUse: [
        "Do not use it to inspect full Task journal history; batch-read selected Tasks instead.",
        "Do not use it to poll Worker runtime or infer progress from terminal activity.",
        "Do not use it immediately after a mutation receipt that already contains post-state.",
      ],
      sideEffects: [
        "A persisted snapshot establishes the hidden incremental baseline at its observed head.",
        "A persisted updates result advances the hidden baseline through all returned changes.",
        "Cancellation or unavailable authority advances no baseline and publishes no Team observation.",
      ],
      parameters: TeamSyncParametersSchema,
      result: TeamSyncResultSchema,
      examples: [
        { id: "snapshot", title: "Current snapshot", call: snapshotCall, result: snapshotResult },
        { id: "updates", title: "Incremental updates", call: updatesCall, result: updatesResult },
        { id: "unavailable", title: "Required authority unavailable", call: snapshotCall, result: unavailableResult },
      ],
    },
    {
      name: "ensure_worker",
      label: "Ensure Worker",
      responsibility: "Create or reuse a short-lived Worker for one semantically deep area in the active Team.",
      actors: ["leader"],
      commonUseCases: [
        "Create one Worker whose area can proceed with little prerequisite overlap.",
        "Reconnect or reuse that Worker while its semantic area remains active.",
      ],
      whenNotToUse: [
        "Do not encode one Task as Worker scope; assign executable work through Tasks.",
        "Do not split work when Workers would repeatedly read the same context or block on each other.",
        "Do not keep a Worker after its semantic area and nonterminal Tasks are complete.",
      ],
      sideEffects: [
        "Creates, reconnects, or reuses one logical Worker in the active Team.",
        "Does not assign a Task or claim model readiness.",
        "The same name with a materially different scope is refused rather than silently redefined.",
      ],
      parameters: EnsureWorkerParametersSchema,
      result: EnsureWorkerResultSchema,
      examples: [
        { id: "create-worker", title: "Create a deep-area Worker", call: ensureWorkerCall, result: ensuredWorkerResult },
        { id: "scope-conflict", title: "Refuse a conflicting existing scope", call: ensureWorkerCall, result: refusedWorkerResult },
        { id: "worker-unavailable", title: "No active Team is bound", call: ensureWorkerCall, result: unavailableWorkerResult },
      ],
    },
    {
      name: "worker_stop",
      label: "Stop Worker",
      responsibility: "Stop one Worker only after its nonterminal Tasks are resolved and exact terminal stop evidence is confirmed.",
      actors: ["leader"],
      commonUseCases: ["Retire a completed semantic Worker area without changing Task history."],
      whenNotToUse: ["Do not stop the leader or a Worker with nonterminal assigned Tasks."],
      sideEffects: ["Deactivates only the exact current Membership after terminal stop evidence.", "Never changes Task state."],
      parameters: WorkerStopParametersSchema,
      result: WorkerStopResultSchema,
      examples: [],
    },
    {
      name: "team_shutdown",
      label: "Shutdown Team",
      responsibility: "Stop every Worker and close the exact leader Team; failed stops keep current Memberships and permit retry.",
      actors: ["leader"],
      commonUseCases: ["Close a completed Team while retaining Task authority and history."],
      whenNotToUse: ["Do not recreate a Team while current Memberships remain."],
      sideEffects: ["Stops Workers with exact terminal evidence, then deactivates the leader Membership only after all stops succeed.", "Retains Task authority and unfinished Tasks."],
      parameters: TeamShutdownParametersSchema,
      result: TeamShutdownResultSchema,
      examples: [],
    },
    {
      name: "task_link",
      label: "Link Task",
      responsibility: "Add or remove one typed Task relation with graph and version validation using the latest Task version; closure does not freeze the version.",
      actors: ["leader"],
      commonUseCases: ["Record a blocking, parent, or related relation between current Tasks."],
      whenNotToUse: ["Do not use a relation as a substitute for assignment, progress, or an Alert."],
      sideEffects: ["Changes only the requested relation when graph and version checks pass.", "A no-op or refusal changes no graph state."],
      parameters: TaskLinkParametersSchema,
      result: TaskLinkResultSchema,
      examples: [],
    },
    {
      name: "alert_send",
      label: "Send Alert",
      responsibility: "Send exceptional clarification, attention, or announcement without changing Task state.",
      actors: ["leader"],
      commonUseCases: ["Escalate exceptional coordination to one current Worker or announce to the Team."],
      whenNotToUse: ["Do not use an Alert to assign, advance, block, or complete a Task."],
      sideEffects: ["Delivers through exact current Memberships and appends one Alert event.", "A refused Alert creates no delivery, event, or Task change."],
      parameters: AlertSendParametersSchema,
      result: AlertSendResultSchema,
      examples: [],
    },
  ],
  scenarios: [
    {
      id: "start-team",
      title: "Start a long-lived Team",
      tool: "team_create",
      situation: "An unbound leader Session has one durable coordination purpose and no active Team.",
      leaderDecision: "Create one Team whose purpose remains useful across several Worker areas and Tasks.",
      call: createTeamCall,
      result: createdTeamResult,
      expectedReasoning: [
        "The Team purpose states the durable outcome, not one short Task.",
        "The exact calling Session becomes the leader authority for later calls.",
        "Workers and Tasks are created separately when concrete areas and outcomes are known.",
      ],
      reviewQuestions: [
        "Does the purpose remain useful for the full release effort?",
        "Is any low-level backend or terminal choice leaking into Team creation?",
        "Can later leader calls resolve this Team without a model-visible Team locator?",
      ],
    },
    {
      id: "deep-worker-scope",
      title: "Create one deep-area Worker",
      tool: "ensure_worker",
      situation: "A long-lived release Team needs independent verification without making every Worker reread package-construction context.",
      leaderDecision: "Choose a Worker identity and semantic area that can run with low context overlap and few dependencies.",
      call: ensureWorkerCall,
      result: ensuredWorkerResult,
      expectedReasoning: [
        "release-verifier owns one cohesive verification area, not one transient Task.",
        "The scope avoids candidate construction and publication implementation work.",
        "Executable verification work must still arrive through assigned Tasks.",
      ],
      reviewQuestions: [
        "Does the name remain useful when shown repeatedly in Team snapshots and Task assignments?",
        "Is the scope deep enough to minimize shared prerequisite context?",
        "Would this split increase concurrency rather than create a dependency lock?",
      ],
    },
    {
      id: "post-compaction-warm-up",
      title: "Warm up after compaction",
      tool: "team_sync",
      situation: "The long-lived leader Session compacted and no post-compaction Team snapshot exists on the active branch.",
      leaderDecision: "Recover current ownership, blockers, and next actions before changing the plan.",
      call: snapshotCall,
      result: snapshotResult,
      expectedReasoning: [
        "task-17 is active and ready for publication dry run.",
        "task-23 is waiting on task-17 rather than independently blocked.",
        "No Task journal replay or transport cursor is needed.",
      ],
      reviewQuestions: [
        "Can you choose the next leader action without batch-reading Task history?",
        "Which Task-card field is unnecessary for that decision?",
        "Which missing fact would force a batch task_read?",
      ],
    },
    {
      id: "routine-supervision-update",
      title: "React to completion and blocker changes",
      tool: "team_sync",
      situation: "The leader was caught up. One Worker completed delivery while another became blocked.",
      leaderDecision: "Choose whether to rebuild the candidate or correct provenance, and avoid redispatching completed work.",
      call: updatesCall,
      result: updatesResult,
      expectedReasoning: [
        "task-17 is complete and needs no further delegation.",
        "task-23 is blocked by a digest mismatch and needs a leader decision.",
        "The latest Task state appears once even though several change kinds occurred.",
      ],
      reviewQuestions: [
        "Can you make the rebuild-versus-correction decision from this update?",
        "Would any new journal entry change that decision?",
        "Is the current context concise enough for routine supervision?",
      ],
    },
  ],
} as const;

export type ModelToolCatalog = typeof modelToolCatalog;
