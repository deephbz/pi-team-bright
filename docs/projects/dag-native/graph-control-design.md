# Graph-native Task control

Date: 2026-08-13
Stage: hardening a runnable integration candidate
Status: production composition is implemented on `feature/dag-graph-control`; acceptance and merge remain open
Machine transition source: [`graph-control-transition-spec.json`](graph-control-transition-spec.json)
Executable contract: [`graph-control.ts`](../../../src/task-authority/graph-control.ts)

## Decision target

The leader applies a complete mission Task graph. Task authority then moves work
through the graph without leader handoff calls. This is ordinary directed graph
control. It does not add a `Workflow` product entity.

The design replaces `closed` with the goal outcomes `goal_achieved` and
`goal_failed`. Only `goal_achieved` satisfies a success dependency. Thus, the
failed Auto Compact review cannot release verification.

This slice keeps the package in hardening. The graph authority now has a
Team-scoped durable snapshot, ready delivery, Coordination reads, lifecycle
guards, and Pi tool registration. Beads remains a legacy read fallback before
the first graph apply; it is not a graph-state mirror.

## Small ontology

The four stored nouns are:

- A `TaskGraphRevision` is one immutable, complete leader declaration.
- A `Task` is one stable goal node across graph revisions. It is not an
  execution.
- An `Attempt` is one immutable execution of a Task activation.
- An `OperationReceipt` gives exact command replay.

A Task has one stable Worker assignee. It can also select the configured model
alias `default` or `capable`. These are separate coordinates. The Attempt
captures the Worker, alias, and resolved model, so a later alias configuration
change cannot rewrite history.

Goal prose carries the criterion until a machine must address criteria
separately. There is no `Criterion`, `RetryTask`, `SchedulerState`, or
`Workflow` entity.

## Concept graph

```text
TaskGraphRevision --defines--> Task
Task --assigned_to-----------> Worker
Task --selects---------------> ModelAlias --resolves_for--> Attempt.model
Task --needs_goal_achieved---> Task
Task --on_goal_failed--------> Task
Attempt --executes-----------> Task
Attempt --binds_to-----------> accepted prerequisite Attempt(s)
Attempt --records------------> goal_achieved | goal_failed
OperationReceipt --replays---> graph apply | Task transition
```

The `needs_goal_achieved` edges form a DAG. An `on_goal_failed` edge can target
itself or one transitive success prerequisite. This adds a directed cycle, but
only failed criteria can traverse it. Each failure edge has a finite traversal
limit from 1 through 8.

## State and transition rules

Task state is a current projection, not an authored lifecycle label.

- `dependency_waiting` is derived when a current prerequisite has no accepted
  Attempt. A Worker cannot author this as `blocked`.
- `ready` is derived when all current prerequisite Attempts achieved their
  goals.
- `in_progress` means one current Attempt occupies the assigned Worker slot.
- `blocked` means that current Attempt has an external impediment with evidence.
  It releases the slot but does not complete, satisfy, or fail a dependency.
- `goal_achieved` means the current Attempt passed the Task criterion. This is
  the only success-edge release state.
- `goal_failed` means no repair route can currently advance the goal. A typed
  reason gives criterion failure, dependency failure, dependency cancellation,
  or failure-edge exhaustion.
- `cancelled` is an administrative terminal state. It is not goal failure and
  never traverses a failure edge.

The public update verb accepts actions, not derived states: `claim`, `block`,
`resume`, `goal_achieved`, `goal_failed`, and `cancel`. A context-only update
can omit a transition. Thus, a caller cannot set `ready` or
`dependency_waiting` directly.

One external command commits one event group and then runs internal graph
movement to quiescence before it returns. This applies the SCXML
run-to-completion lesson while avoiding statechart vocabulary in the product
model (<https://www.w3.org/TR/scxml/>). All internal loops have finite bounds.

## Success, failure, and repair

For `plan -> implement -> review -> verify`, declare:

```text
plan --success--> implement --success--> review --success--> verify
                          ^                 |
                          +----failure------+
                               max 2
```

A failed review appends its failed Attempt. Task authority then traverses the
failure edge to implementation. It invalidates implementation and its reverse
success closure. Implementation becomes `ready`; review and verification
become `dependency_waiting`. Old Attempt records stay in history, but they
cannot release new work.

After new implementation success, review gets a new activation. That activation
contains the exact new implementation Attempt ID. Verification becomes ready
only after the new review Attempt achieves its goal.

The bound belongs to the failure edge, not to a generic scheduler retry. A self
edge gives a bounded retry. An edge to an earlier prerequisite gives bounded
repair. When its budget is used, the source stays `goal_failed` with
`failure_edge_exhausted`; no eighth routine state is needed.

The executable first contract allows one failure edge per Task. This prevents
ambiguous routing and excludes arbitrary cycles. A future need for conditional
or multiple failure edges must first define deterministic selection and token
cost.

## Joins and activation identity

A join uses all-success semantics. It becomes ready only when every current
prerequisite has one accepted `goal_achieved` Attempt. This adapts the workflow
synchronization rule and prevents an upstream failure from becoming silent
waiting (<http://www.workflowpatterns.com/patterns/control/basic/wcp3.php>).
Airflow's default `all_success` rule has the same useful property; `all_done`
would reproduce the incident
(<https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html#trigger-rules>).

An activation key is a digest of:

- the semantic Task definition lineage;
- the number of current repair traversals to the Task; and
- the exact accepted prerequisite Attempt IDs.

Thus, a join cannot mix one old prerequisite result with one new result by
accident. A repair traversal or changed input creates a new activation. Current
work for the old activation becomes `superseded`.

## Atomic revision

`task_graph_apply` is the proposed breaking replacement for `task_create`. The
first apply omits `expected_graph_version`. Each revision supplies the exact
current `GraphVersionRef`. The complete graph validates before any mutation.

A change to title, goal, Worker,
model alias, dependencies, or failure edge creates new lineage. Unchanged Tasks
retain accepted results when their exact inputs also remain current. A changed
Task invalidates its reverse success closure. A changed in-progress Attempt is
superseded; its late completion fails the Task-version guard.

Removal keeps earlier graph revisions and Attempt history. The current
projection no longer contains the removed Task.

This follows the useful Skyframe rule: immutable values plus exact dependency
lineage permit reverse-transitive invalidation and deterministic parallel work
(<https://bazel.build/reference/skyframe>). It does not copy Skyframe's build
ontology.

## Recovery and replay

The snapshot contains immutable graph revisions, append-only Attempt and edge
events, and operation receipts. Recovery folds those records and derives Task
state. Exact operation replay returns its stored receipt. Reuse with changed
semantics refuses before mutation.

A production adapter must commit the event group and receipt before delivery.
It must fence delivery by Task version and activation key. It can then restore
missing ready-front delivery intent after a crash. This adopts Temporal's
append-only history and deterministic replay boundary without adding a
Workflow entity (<https://docs.temporal.io/workflow-execution/event> and
<https://docs.temporal.io/workflow-definition>).

## Public model surface

Keep nine leader tools and three Worker tools. Add no tool.

```ts
task_graph_apply({
  operation_id,
  expected_graph_version?,
  tasks: [{
    key, title, goal, assignee,
    model?: "default" | "capable",
    needs?: string[],
    on_goal_failed?: { target, max_traversals }
  }]
})

task_update({
  task_id, operation_id, expected_version, worker?,
  transition?: "claim" | "block" | "resume" |
    "goal_achieved" | "goal_failed" | "cancel",
  current_context?, evidence?
})
```

The measured current provider surface is 1,181 `o200k_base` content tokens.
The proposed schemas use 1,177 tokens, a reduction of 4. Both figures serialize
provider name, description, and parameters as compact registration-order JSON;
provider framing is excluded. The prior accepted report measured 1,191 for the
full registered surface with canonical key sorting, so these absolute figures
are not cross-method replacements. The same-method delta is the valid claim.
Run `scripts/measure-graph-control-surface.ts` and tokenize its two tool arrays
to reproduce the comparison.

`task_graph_apply` costs 366 tokens and the proposed `task_update` costs 187 in
this measurement. The graph fields add meaning, but the action-only update
removes authored state and batch grammar. No new verb is added.

## Production integration seam

`GraphTaskController` is backend-neutral. An adapter can call `applyGraph`,
`transition`, `readTasks`, `selectReadyFrontier`, `snapshot`, and `recover`.
The direct integration order is:

1. Persist controller snapshot or event group with its operation receipt.
2. Project current cards from `readTasks`.
3. Dispatch `selectReadyFrontier`, at most one Task per Worker.
4. Require the exact Task version for every Worker transition.
5. Keep full `trace()` output for investigation; keep routine cards small.

The current Beads mapping cannot represent these facts with native
`open/in_progress/blocked/closed` alone. Do not map `goal_failed` to `closed`.
A first adapter can persist graph revision, Attempts, outcomes, and failure
traversals in Task-owned metadata or an authority side record, then project
Beads state only as a compatibility carrier. Migration must preserve old
`closed` records as legacy completion facts, not silently certify them as
`goal_achieved`.

## Evidence and remaining risks

The smoke check covers the Auto Compact repair, exact input Attempt lineage,
join readiness, self-loop exhaustion, cancellation, replay, recovery, graph
revision, model resolution, and stale completion. It does not prove durable
Beads transaction behavior or Pi delivery recovery.

The following choices still need repeated real-Team evidence:

- Whether a model-alias configuration change should schedule new Attempts or
  affect only future activations.
- Whether a blocked Attempt should keep its Worker slot. This contract releases
  it, consistent with the existing one-slot policy.
- Whether concurrent failure demands need coalescing. The one-failure-edge rule
  removes route ambiguity, but a later fan-in repair design needs an ordered
  demand-set activation key.
- Whether a future graph patch verb is worth its replay and token cost. Complete
  atomic apply is smaller and safer now.

Architecture impact is `changed` for the proposed Task authority and model
contract, but `none` for deployed behavior in this branch. Pi Team Bright stays
opaque at the HyperCarrier integration boundary, so this isolated contract adds
no HyperCarrier Structurizr change.
