# Canonical Task domain cutover

Date: 2026-08-05
Task: `beads-call-minimization-znc` — Design canonical Task domain cutover

## Decision

The agent-facing Task change payload uses the same canonical Task card as
`task_read` and `team_sync`. It does not carry a raw `TaskFile` snapshot.

The canonical card contains only the coordinates needed for the next agent
decision: `id`, bounded `title`, executable `goal` or `goal_state: incomplete`,
`status`, optional `assignee`, `current_context`, and opaque `version`.
Descriptions, acceptance criteria, design text, authority identifiers, raw
versions, relations, and delivery identifiers remain outside the payload.

The Task authority remains the source of truth. The card is an immutable
publication projection at one authority version. It is not a write authority,
progress signal, or replacement for `task_read`.

## Cutover rules

- New deliveries persist `taskProjection`, not `taskSnapshot`.
- Existing records with `taskSnapshot` are handled only during the stopped-epoch
  migration. The migration lists the Team scope, hydrates IDs through the Beads
  adapter, and atomically replaces records; normal delivery rejects legacy keys.
- Owner-transition and enqueue-recovery records persist the canonical card and
  opaque TaskVersionRef coordinates. They do not persist authority identifiers.
- Startup reconciliation remains a separate verification point. It must not
  add one detailed read per Task merely to rebuild the card; the exact metadata
  source still needs lead verification.
- Missing or invalid candidate metadata cannot become executable prose. The
  projection uses the explicit unavailable-context or incomplete-goal state.
- Raw authority records and historical raw snapshots remain evidence only. They
  are not part of the model-facing contract.

## Implementation anchors

- `src/model-tool-contract/beads-task-adapter.ts` owns native-record and
  candidate-metadata translation into cards.
- `src/utils/task-delivery.ts` owns card persistence and delivery formatting;
  it does not rebuild cards from authority records.
- `src/utils/tasks.ts` carries candidate metadata from accepted mutations into
  delivery publication.
- `src/model-tool-contract/in-memory-team-port.ts` and the model catalog own the
  executable Task-card schema.

## Handoff

This was a read-only design Task. The shared checkout contained concurrent
implementation changes. Exploratory production edits from this Session were
reverted; the net durable artifact from this Session is this journal entry.

Prior focused evidence in the shared tree passed `npm run typecheck` and 47
focused tests across `task-delivery`, `clean-cut-round2`,
`beads-task-adapter`, `durable-model-tool-port`, and
`mutation-call-minimization`. The lead must verify the final shared tree before
accepting that evidence.

Risks: legacy outbox records may contain only raw snapshots; malformed or
oversized candidate metadata must not become executable Task prose; and startup
reconciliation must preserve context without an N+1 authority read.

Next action: after the mixed-version Team shuts down, the lead should verify the
canonical card against the executable schemas, decide the reconciliation source,
and assign implementation only after accepting this design.

This cutover does not make a delivery current. A recipient must use `task_read`
or `task_sync` when it needs current authority state. The compatibility path can
be removed after all persisted delivery and outbox records pass one release
boundary and a migration audit finds no raw-only records.
