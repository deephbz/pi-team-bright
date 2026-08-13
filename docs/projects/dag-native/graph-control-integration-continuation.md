# Graph-control production integration continuation

Updated: 2026-08-13
Branch: `feature/dag-graph-control`
Base before this slice: `6c4618f55409f753ccca3cac8dc224cda150b8cb`
Stage: hardening a runnable vertical slice
Status: implementation and focused verification complete; commit pending

## Goal still in force

Wire `GraphTaskController` into the real Pi Team Bright Task application,
durable recovery, ready delivery, Coordination reads, and the model-facing
contract. Replace overloaded `closed` behavior with `goal_achieved` and
`goal_failed`. Keep `dependency_waiting` and `ready` derived. Traverse explicit
bounded failure edges mechanically. Resolve `default` and `capable` aliases for
each Attempt. Keep the tool count unchanged by replacing `task_create` with
`task_graph_apply`.

Run only typecheck and one vertical smoke after the tree is stable. Commit with
the configured public identity. Do not push, publish, merge, or edit the TUI
worktree.

## Current implementation direction

The slice uses one Team-scoped durable JSON snapshot as the graph-native Task
authority. It stores graph revisions, immutable Attempt events, operation
receipts, and captured alias values. Beads remains the legacy authority before
the first graph apply; it is not yet a graph-state mirror. This is an explicit
integration gap, not an inference that native Beads status can represent
Attempts or goal outcomes.

A graph mutation commits its controller snapshot before Coordination event
publication or delivery. Publication and ready-delivery failures become
warnings. Recovery reloads the snapshot and derives the ready frontier. Worker
claims and results use exact Task versions. Graph cards contain the current
Attempt summary, accepted Attempt identity, prerequisite lineage, model alias,
and derived state.

Legacy `TaskCard` types remain stable for old Beads code and tests. A separate
`CanonicalTaskCard` union is being introduced only at delivery and
Coordination boundaries. This corrected an earlier broad type widening that
caused unrelated legacy tests to infer graph statuses.

## Files added

- `src/adapters/durable-graph-task-authority.ts` wraps the controller with a
  locked atomic Team snapshot, reads, transitions, replay, recovery, and ready
  frontier selection.
- `src/task-authority/graph-orchestration.ts` publishes committed graph changes
  and reconciles ready delivery.
- `src/adapters/durable-graph-task-read.ts` selects graph reads after first
  apply and Beads reads before it.
- `src/adapters/durable-graph-assigned-work.ts` derives lifecycle guards from
  graph terminal states.
- `src/adapters/composite-assigned-work-guard.ts` selects graph or legacy
  lifecycle guards.

## Files materially changed

- `src/task-authority/graph-control.ts` now supports context-only operations,
  persists Task context events, exposes durable alias-bearing snapshots, and
  permits an optional transition when context changes.
- `src/task-authority/graph-control-schemas.ts` now defines graph apply,
  singleton transition, derived state, Attempt summary, and graph Task-card
  schemas.
- `src/task-authority/task-domain.ts` now keeps legacy `TaskCard` stable and
  adds `CanonicalTaskCard`, `isGraphTaskCard`, and `isTaskTerminal`.
- `src/utils/paths.ts` now owns the graph authority snapshot path.
- `src/utils/task-delivery.ts`, `src/task-authority/ready-dispatch.ts`, and
  Task-publication contracts accept canonical graph cards at their integration
  seams.
- `src/model-tool-contract/durable-model-tool-task-application.ts` routes graph
  apply, reads, and transitions through graph orchestration, with legacy reads
  before first apply.
- `src/model-tool-contract/catalog.ts` defines the breaking
  `task_graph_apply` and singleton `task_update` schemas.
- `src/model-tool-contract/executors.ts` maps graph apply and transition
  results.
- `src/model-tool-contract/pi-registration.ts` registers
  `task_graph_apply` instead of `task_create`.
- `extensions/index.ts` composes graph authority, graph orchestration,
  Coordination graph reads, graph lifecycle guards, graph ready recovery, and
  Worker graph reads/transitions.
- Coordination query and observation contracts are being widened only to
  `CanonicalTaskCard` where graph cards can actually arrive.

## Verified state

- `npm run typecheck` passed after runtime composition, Coordination widening,
  model projection, and singleton Task transitions stabilized.
- `npx vitest run src/task-authority/graph-control.integration.smoke.test.ts`
  passed one file and one test.
- The focused smoke proved durable recovery, exact Attempt lineage, alias
  capture, ready-only delivery, bounded repair traversal, and no verification
  release after failed review.

The durable result is
[`../../journal/2026-08-13-graph-control-integration-result.md`](../../journal/2026-08-13-graph-control-integration-result.md).
The only remaining local actions are final diff review, removal of the temporary
`node_modules` symlink, commit, and Task closure.

## Known integration gaps to report unless closed

- The graph authority snapshot and Beads are separate. Graph writes do not
  materialize Beads nodes or relations, so external Beads readers do not see
  the new graph.
- Snapshot replacement is atomic, but it is not an append-only database
  transaction. History is append-only inside each snapshot value.
- Alias resolution currently uses `PI_TEAM_BRIGHT_MODEL_DEFAULT` and
  `PI_TEAM_BRIGHT_MODEL_CAPABLE`, then the current configured Worker model as a
  fallback. Existing active Memberships are not relaunched when a Task selects
  `capable`; the Attempt records the selected resolved model, but carrier model
  actuation still needs an explicit policy.
- Coordination event publication can be recovered only as changed current
  state; exact missing event replay is not yet a graph-specific outbox.
- Legacy Teams are readable before first apply, but no automatic legacy
  `closed` migration exists. This is intentional: `closed` cannot certify
  `goal_achieved`.
- The graph-pane projection still reads Beads through its existing factory and
  is outside this Task's non-TUI scope.

## Architecture impact

Architecture impact is `changed` inside Pi Team Bright: Task authority,
persistence flow, model contract, dispatch, and Coordination reads now gain a
graph-native path. HyperCarrier diagrams keep Pi Team Bright opaque, so no
canonical Structurizr update is expected for this isolated internal change.
