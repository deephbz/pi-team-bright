# Graph-control production integration result

Date: 2026-08-13
Branch: `feature/dag-graph-control`
Integrated base: `6c4618f55409f753ccca3cac8dc224cda150b8cb`
Stage: hardening
Architecture impact: changed inside Pi Team Bright; HyperCarrier's canonical diagram keeps Pi Team Bright opaque

## Result

Pi Team Bright now composes `GraphTaskController` as a runnable Task-authority
path. The leader applies one complete graph through `task_graph_apply`. Workers
use singleton `task_update` commands to claim, block, resume, report
`goal_achieved` or `goal_failed`, cancel, or record context. Callers cannot
author `dependency_waiting` or `ready`.

A Team-scoped locked snapshot stores graph revisions, immutable Attempt events,
operation receipts, and the resolved `default` and `capable` aliases. The
authority commits the snapshot before Coordination publication or delivery.
Recovery reloads the snapshot, derives current Task states, and reconciles the
ready frontier.

Only `goal_achieved` satisfies a prerequisite. A failed review applies its
explicit bounded failure edge and reactivates the repair target. Verification
stays waiting until a later review Attempt achieves its goal. Join Tasks bind
to exact accepted prerequisite Attempt IDs.

Delivery and Coordination now accept a `CanonicalTaskCard` union at their
integration seams. Legacy Beads card types remain narrow inside existing Beads
code. Lifecycle guards treat `goal_achieved`, `goal_failed`, and `cancelled` as
terminal graph states.

The registered leader tool count remains nine. `task_graph_apply` replaces
`task_create`; the old name exists only as a result-projection decode alias and
is not registered. Model receipts retain graph versions, replay truth, derived
ready IDs, failure traversal, and delivery warnings.

## Verification

- `npm run typecheck` passed.
- `npx vitest run src/task-authority/graph-control.integration.smoke.test.ts`
  passed one file and one test.
- The smoke applied a four-Task Team graph, delivered only `plan`, captured the
  `capable` model on the implementation Attempt, traversed
  `review -> implement`, recovered from disk, kept `verify` waiting after the
  failed review, and delivered `verify` only after the repaired review passed.

## Exact remaining gaps

- The graph snapshot and Beads are separate authorities. Graph writes do not
  materialize Beads records, so external Beads readers cannot see them.
- Snapshot replacement is atomic, but the store is not an append-only database
  transaction. Immutable history lives inside each replacement snapshot.
- Alias resolution captures the resolved model on each Attempt. It does not
  relaunch an existing Membership when a Task selects `capable`, so carrier
  model actuation still needs a policy.
- Coordination can recover changed current graph state after a publication
  failure, but it has no graph-specific exact-event outbox.
- Legacy Teams remain readable before their first graph apply. No automatic
  `closed` migration exists because `closed` cannot prove `goal_achieved`.
- The read-only Task graph pane still reads Beads. TUI integration is owned by
  the separate TUI lane.
- Leader `task_update` can cancel or write context. Worker-fenced execution
  transitions refuse the leader identity, so claims and goal outcomes remain
  assigned-Worker actions.

## Source anchors

- Graph authority and history: `src/task-authority/graph-control.ts`
- Durable recovery: `src/adapters/durable-graph-task-authority.ts`
- Publication and dispatch: `src/task-authority/graph-orchestration.ts`
- Public schemas: `src/task-authority/graph-control-schemas.ts`
- Runtime composition: `extensions/index.ts`
- Vertical proof: `src/task-authority/graph-control.integration.smoke.test.ts`
