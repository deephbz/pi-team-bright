# Graph-control integration and migration note

Date: 2026-08-13
Status: executable first contract; production integration pending

## Breaking contract

Replace leader `task_create` with `task_graph_apply`. It applies one complete
mission graph and uses `expected_graph_version` for revisions. Replace authored
Task statuses with Task transitions. Replace `closed` with the distinct outcomes
`goal_achieved` and `goal_failed`.

Keep `dependency_waiting` and `ready` derived. Keep `blocked` only for an
external impediment to one active Attempt. Keep `cancelled` separate from goal
failure.

Task assignment stays a stable Worker name. `model` is an optional configured
alias, `default` or `capable`. It is not Worker identity. Each Attempt stores the
resolved model.

## Direct integration steps

1. Put [`GraphTaskController`](../../../src/task-authority/graph-control.ts)
   behind the Task application port.
2. Store graph revisions, events, and operation receipts atomically. The
   in-memory snapshot is a transport shape, not a required database layout.
3. Project routine Task cards from `readTasks()`. Project Attempt history only
   in trace or debug reads.
4. Dispatch `selectReadyFrontier()` after each committed graph apply or Task
   transition. Persist delivery intent before presentation.
5. Fence claim and completion with the exact Task version. Also keep the
   activation key in durable delivery evidence.
6. Resolve model aliases when claim starts an Attempt. Do not resolve them when
   the graph is authored.
7. On recovery, restore the controller, derive the ready front, and reconcile
   missing delivery intent. Exact operation replay must not create another
   Attempt or failure traversal.

## Legacy data

A legacy `closed` Task proves only that the old lifecycle completed. It does not
prove its goal passed. Migration must use one of these explicit policies:

- import it as `goal_achieved` only when durable success evidence exists;
- import it as `goal_failed` when durable failure evidence exists; or
- retain it as legacy unresolved completion outside the new runnable graph.

Do not infer success from `closed`. Do not delete old journal or relation
records. Initial graph revision import must assign stable Task keys and record
the source Task IDs.

Existing `blocked_by` relations can become `needs` edges only after direction,
identity, and cycle validation. Existing `blocked` state needs evidence that it
was an external impediment. Ordinary dependency waiting becomes the derived
`dependency_waiting` projection.

## Adapter constraint

Native Beads states cannot carry current accepted Attempt identity or bounded
failure traversal. A Beads adapter needs Task-owned metadata or a side record
for graph version, Task lineage, Attempt records, activation keys, outcomes,
and operation receipts. Never encode these distinctions only in prose or map
both goal outcomes to `closed`.

The transition JSON is the shaping authority. After ratification, exact rules
must migrate into public types, the durable adapter, and contract tests. The
design documents then keep only intent, rationale, and migration history.
