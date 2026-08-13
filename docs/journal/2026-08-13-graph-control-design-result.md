# Graph-control executable design result

Date: 2026-08-13
Branch: `feature/dag-graph-control`
Base commit: `8b6d82876a133e96ef8614ef2916e55d28b4ac03`
Stage: shaping with a direct-integration executable contract

## Result

The slice adds a backend-neutral `GraphTaskController`. It can atomically apply
and revise a complete Task graph, run typed Task transitions, derive the ready
front, preserve immutable Attempts, traverse bounded failure edges, resolve
`default` and `capable` model aliases per Attempt, recover from a snapshot, and
replay exact operation receipts.

The smallest behavioral distinction is now executable: Attempt completion is
history, while only the current `goal_achieved` Attempt satisfies a success
edge. A failed review therefore routes to repair and cannot release empirical
verification.

The proposal removes `closed`. Current Task projections use
`dependency_waiting`, `ready`, `in_progress`, `blocked`, `goal_failed`,
`goal_achieved`, and `cancelled`. Cancellation stays separate because it is an
operator action, not a criterion result.

## What changed in the model

Worker identity and model selection are separate. Each Task has one stable
Worker assignee and an optional model alias. Each Attempt stores the alias and
resolved model. The earlier draft treated Worker and alias as alternative
executor variants; this result rejects that collapse.

Failure bounds belong to explicit edges. A self edge is a retry. An edge to one
transitive prerequisite is repair. The success subgraph remains acyclic. The
contract allows one failure edge per Task, so failure routing is deterministic.

A graph revision preserves unchanged semantic Task lineage. A changed goal,
assignment, alias, dependency, or failure edge invalidates the reverse success
closure. Superseded Attempt records remain traceable and cannot release work.

## Verification evidence

The focused smoke suite passed three tests. It exercised:

- the Auto Compact `plan -> implement -> review -> verify` repair loop;
- no verification release after failed review;
- new review input bound to the new implementation Attempt;
- join all-success readiness;
- bounded self-loop exhaustion;
- cancellation without failure traversal;
- exact operation replay and snapshot recovery;
- graph revision with unchanged-result preservation;
- superseded in-flight work and stale completion refusal;
- atomic refusal of an invalid revision and changed operation replay; and
- `capable` alias resolution captured on the implementation Attempt.

The smoke command was:

```text
npm run typecheck
npx vitest run src/task-authority/graph-control.smoke.test.ts
```

The worktree had no installed dependencies, so the check used the matching DAG
worktree's dependency directory through a temporary untracked symlink. The
symlink was removed after the command.

## Surface measurement

The evaluator in `scripts/measure-graph-control-surface.ts` captured current and
proposed provider definitions. With compact registration-order JSON and
`tiktoken` `o200k_base`, the current nine leader tools used 1,181 content
tokens. The proposed nine tools used 1,177, a reduction of 4. Provider framing
was excluded.

The proposed `task_graph_apply` definition used 366 tokens. The proposed
transition-based `task_update` used 187. The result adds no model tool.

The earlier accepted budget report used canonical object-key sorting and found
1,191 current tokens. Therefore, only the same-method 1,181-to-1,177 comparison
is a valid delta. The absolute results do not replace the accepted budget
baseline.

## Contradictions and limits

The current Beads adapter treats `closed` as dependency success. That contract
contradicts the new accepted-success invariant. Direct integration must store
Attempt outcome and input lineage outside native Beads status fields.

The code is not connected to Pi registration, Beads persistence, or durable
delivery. Snapshot recovery anchors deterministic transition replay, but it does
not prove transactional crash recovery. The leader will integrate both graph
branches and run repeated real Pi Team workflows.

A title change creates new semantic lineage because titles can alter Worker
interpretation. Model-alias configuration changes affect future Attempts, not
existing success; live runs can reverse that policy.

## Architecture impact

The proposed Task authority and model contract have architecture impact
`changed`. Deployed behavior on this branch has impact `none` because the
controller is not wired to production. HyperCarrier's canonical diagrams treat
Pi Team Bright as opaque, so this slice requires no Structurizr change.

## Durable artifacts

- `docs/projects/dag-native/graph-control-design.md`
- `docs/projects/dag-native/graph-control-transition-spec.json`
- `docs/projects/dag-native/graph-control-migration.md`
- `src/task-authority/graph-control.ts`
- `src/task-authority/graph-control-schemas.ts`
- `src/task-authority/graph-control.smoke.test.ts`
- `scripts/measure-graph-control-surface.ts`
