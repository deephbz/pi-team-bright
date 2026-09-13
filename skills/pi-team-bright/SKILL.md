---
name: pi-team-bright
description: Use when coordinating Workers or executing an assigned Task with Pi Team Bright.
---

# Pi Team Bright

A Team holds a durable project or coordination boundary. A Worker holds a reusable
scope and working context. A Task assigns one bounded outcome to a Worker.
These have separate lifecycles: finishing a Task does not end its Worker or Team.

## Lead: own the project and coordinate execution

The one lead carries two responsibilities:

- Project lead: communicate with the user, understand and preserve intent and
  constraints, choose an approach, decompose work, evaluate outcomes, and explain
  trade-offs. Delegation does not transfer accountability or the user's authority.
- Coordinator: assign Tasks to suitable Workers, provide context and resources,
  resolve blockers, supervise outcomes, and escalate decisions to the user.

## Lead: choose the work and its owners

Restore an existing Team with `team_sync` snapshot when context is missing.
For a new Team, call `team_create` first; sync does not discover or create Teams.
Reuse the current Team for related requests until the owner ends or resets it.

Reuse suitable Workers. Create one when it enables independent parallel work,
establishes a distinct reusable scope, or isolates a perspective. Implementation,
diagnosis, and repair normally stay with the same Worker. Independent verification
can use another Worker even when it must wait for implementation.

For example, a builder implements and repairs; a reviewer checks independently.
Their scopes stay stable while their assigned Tasks change. Reuse the recorded
Worker name and exact scope with `ensure_worker`; put new work in Tasks, not scope.
A launch receipt proves carrier setup, not that the Worker has accepted work.

## Lead: assign or revise the Task graph

Put the outcome, constraints, needed source pointers, and external success signal
in Task prose. An assigned Task is the work contract. Alerts carry exceptional
clarification or attention, not new assignments or Task state changes.

Use `task_graph_apply` for the complete intended graph. Keep keys stable for the
same Tasks and use new keys for new outcomes. Each revision replaces the current
set: include every Task that should remain current. Changes to goals, assignments,
or dependencies belong here, not in `current_context` or an Alert. Use the graph
version from the accepted apply receipt for a new revision; exact retry rules are
below.

Use `needs` when a Task requires another Task's successful result. Use a bounded
failure route when a failed check should return work for repair. The runtime
selects and delivers eligible Tasks, limits each Worker to one in-progress Task,
and advances success or repair paths. The leader does not manually dispatch each
successor. A failed Attempt can return its Task to waiting while repair runs.

## Lead: supervise and finish the request

Use `team_sync` updates for progress and waiting. Follow its request for a snapshot
when an observation baseline is needed. Mutation receipts already report post-state;
read again only when required meaning is missing, stale, or conflicting.

Define in-flight work as assigned nonterminal Tasks, including waiting or blocked
Tasks. While any remain and the owner has not explicitly paused or stopped work,
every user-facing reply or progress note is an interim message. Make
`team_sync({view:"updates"})` the last action before yielding. This includes blocker
escalations. A mutation receipt does not replace this sync: it reports the lead's
write, while sync observes other Workers and waits for subsequent changes. Handle
returned changes and continue synchronization while work can progress.

`caught_up` means no new change is available now, not that every Task succeeded.
`indeterminate` means observation evidence is incomplete. If work remains, use
current Task and Worker records to identify a blocker or recovery need rather than
repeat identical empty sync calls. Read selected Tasks with `task_read` when needed.
Use terminal evidence for exceptional diagnosis, not as Task progress. State the
blocker and next actor when no actor can progress. Explicit owner pause or stop
instructions remain authoritative.

Report the requested outcome with evidence, or identify the blocker and next action.
Keep reusable Workers and the Team available. Stop a Worker only after its assigned
nonterminal Tasks resolve and its capacity is no longer needed. Shut down the Team
only when the owner explicitly ends or resets its durable boundary; reconcile first.

## Worker: execute the assigned Task

Use your runtime-provided Worker tools and claim an assigned ready Task before work.
Record success or failure with external evidence. Use `block` for an external blocker
and `resume` when it clears. Follow the returned Task state after every transition.
Keep still-relevant execution context in `current_context`; use evidence for outcomes
and blockers. Send an Alert to the lead when exceptional clarification is needed.

## Refusals and recovery

Follow the tool result's recovery action. For an unknown mutation outcome, replay
with the original operation ID and unchanged input, including the expected version.
A conflict requires reconciliation, not a blind retry. Treat a changed request as a
new operation; a delivery warning does not undo an accepted Task mutation.

Use Team tools for normal authority changes. If create reports an active Team while
both sync and shutdown report none, use [stale Team rescue](references/team-rescue.md)
only with explicit owner authorization and its required absence evidence.

Tool schemas own exact parameters. Use the [contract source map](../../docs/reference.md)
when debugging implementation, authority, or projection behavior.
