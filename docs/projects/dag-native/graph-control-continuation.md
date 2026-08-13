# Graph-control design continuation

Updated: 2026-08-13
Task: `ptb-graph-native-next-n60`
Task version at initial handoff: `v_8497232db64fbe90`
Branch: `feature/dag-graph-control`
Stage: shaping with an executable first contract

> Historical compaction handoff. The completed result is in
> [`graph-control-design.md`](graph-control-design.md) and
> [`../../journal/2026-08-13-graph-control-design-result.md`](../../journal/2026-08-13-graph-control-design-result.md).

## Owner clarification now in force

Treat this as ordinary graph engineering, not a new Workflow abstraction. The
leader declares and can atomically revise a mission Task graph. Task authority
then runs internal control flow deterministically, without leader
`team_sync`/`task_update` handoff turns.

The control model is directed, not wholly acyclic. Goal-achievement edges form
the forward DAG. An explicit goal-failure edge can return to the same Task or an
earlier step. Every such edge is deterministic, bounded, and preserved in
Attempt history.

Redesign the model around `dependency_waiting`, `ready`, `in_progress`,
`goal_failed`, `goal_achieved`, and `blocked`. Assess replacing `closed` with
`goal_achieved`; a breaking model contract is allowed. Planning must also admit
configurable model aliases such as `default` and `capable`, rather than one
Team-wide model choice.

## Evidence inspected

The current DAG authority, Beads graph adapter, ready dispatcher, durable
orchestration adapter, leader and Worker tool contracts, accepted records, and
focused tests were inspected. The durable Auto Compact experiment established
two failures:

1. A Worker authored `blocked` while an ordinary dependency was still active.
   This must instead be derived `dependency_waiting`.
2. A failed review was marked `closed`, which released empirical verification.
   Completion history and accepted goal achievement must be different facts.

The incident's leader had to reopen implementation, review, and verification.
A correct failure edge from review to implementation would do this
mechanically, preserve the failed review Attempt, and prevent verification from
starting.

## Current proposal

The machine-readable shaping source is
[`graph-control-transition-spec.json`](graph-control-transition-spec.json), now
at `pi-team-bright-graph-control-design/2`. It proposes:

- immutable graph revisions, stable Tasks, immutable Attempts, and operation
  receipts;
- an acyclic `goal_achieved` subgraph plus explicit bounded
  `goal_failed` edges;
- joins that require current accepted Attempts from every prerequisite;
- activation identity derived from Task-definition lineage, repair traversals,
  and exact prerequisite Attempt IDs;
- stale or superseded Attempts retained as history but unable to release work;
- cancellation that never follows a failure edge;
- append-only recovery, exact replay, stale delivery fencing, and one active
  Attempt per execution slot;
- no new model tool: replace declarative one-time `task_create` with a
  declarative graph-apply verb and revise `task_update` transitions.

The result resolves the assignment question. Worker identity and model alias
are separate coordinates, and each Attempt captures the resolved model.

## Theory and production lessons already collected

Use these sources in the durable design artifact. Do not copy their complete
ontologies.

- W3C SCXML Recommendation: a microstep takes one conflict-free transition set;
  a macrostep runs internal transitions to a stable configuration before the
  next external event. It also ignores late events from a cancelled invocation.
  Adopt atomic run-to-quiescence for one committed Task result or graph
  revision. Bound cycles because SCXML itself permits nonterminating
  macrosteps. <https://www.w3.org/TR/scxml/>
- Workflow Patterns Synchronization: an AND-join enables only after all inputs
  arrive and resets before another activation; an upstream failure can
  otherwise deadlock it. Bind a join to exact accepted prerequisite Attempts
  and project dependency failure explicitly.
  <http://www.workflowpatterns.com/patterns/control/basic/wcp3.php>
- Workflow Patterns Structured Loop: one active loop instance, one entry/exit,
  and an explicit continuation condition. Prefer one explicit bounded failure
  return over arbitrary cycles.
  <http://www.workflowpatterns.com/patterns/control/new/wcp21.php>
- Workflow Patterns Arbitrary Cycles confirms that unrestricted cycles are
  possible but difficult to structure. Reject that generality here.
  <http://www.workflowpatterns.com/patterns/control/structural/wcp10.php>
- Airflow separates Task definition from Task Instance and distinguishes
  `success`, `failed`, `upstream_failed`, and `up_for_retry`. Its default join
  is all-success, while all-done would reproduce the Auto Compact defect.
  Adopt definition/Attempt separation and success-gated joins, but not its
  broad state set. <https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html>
  and <https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html#trigger-rules>
- Temporal persists append-only Event History for recovery and audit, compares
  replayed commands with history, and records non-deterministic external work
  outside replay. It retries individual Activities as new executions and warns
  that retrying a whole deterministic workflow repeats the same failure.
  Adopt append-only transition replay, graph-definition versioning, and
  per-Task Attempts. Do not adopt Workflow as a new product entity.
  <https://docs.temporal.io/workflow-execution/event>,
  <https://docs.temporal.io/workflow-definition>, and
  <https://docs.temporal.io/encyclopedia/retry-policies>
- Dagster attaches bounded retry policy to an operation and permits permanent
  failures to bypass retry. Adopt explicit finite edge traversal and terminal
  failure when repair cannot help.
  <https://docs.dagster.io/guides/build/ops/op-retries>
- Bazel Skyframe records all dependencies, uses immutable values, invalidates
  the reverse transitive closure of changed inputs, and permits independent
  nodes to run in parallel with the same result as sequential evaluation.
  Adopt semantic Task-definition identity, exact input Attempt lineage, and
  reverse-closure invalidation after repair or graph revision.
  <https://bazel.build/reference/skyframe>

## Prototype status at this handoff

The first unverified prototype described below was replaced and removed.
`src/task-authority/graph-control.ts` implements atomic graph
revision, separate Worker and model-alias coordinates, final state names,
replay, recovery, and a focused smoke suite. It remains unwired to production.

## Continuation result

The assigned continuation is complete. The current source bundle provides the
ontology, transition JSON, executable controller, focused smoke checks, model
surface evaluator, integration note, and dated result artifact.

The leader's next step is production integration. Connect the controller to the
Task application port, durable event and receipt storage, and delivery
reconciliation. Then run repeated real Team graphs before contract ratification.
The unresolved choices and reversal tests are in `graph-control-design.md`.
