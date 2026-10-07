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

Reuse suitable Workers. Create one when it enables useful early starts,
establishes a distinct reusable scope, or isolates a perspective. Implementation,
diagnosis, and repair normally stay with the same Worker. Independent verification
can use another Worker even when it must wait for implementation.

Choose a new Worker's model role from the Team creation or snapshot catalog.
Omission selects the configured default model role; without one, select a role
explicitly. Keep model selection at Worker creation. Tasks select an assignee;
reuse keeps the saved binding. Invalid selections return valid model role names.

For example, a builder implements and repairs; a verifier checks independently.
Their scopes stay stable while their assigned Tasks change. Reuse the recorded
Worker name and exact scope with `ensure_worker`; put new work in Tasks, not scope.
A launch receipt proves carrier setup, not that the Worker has accepted work.

## Lead: delegate facts, keep opinions

Workers establish facts. The lead forms opinions. Delegate bounded work whose
result can be checked: searching git history, messages, data artifacts, and
schemas; locating the relevant sources; checking a schema or contract; fixing
lint and type errors; watching CI; running experiments and recording results.
Ask such a Task for located sources with pointers and verified facts, at high
precision and high recall, with observation separated from interpretation.

Do not delegate understanding. Read the located sources yourself and form the
whole picture before you decompose work, review a deliverable, or report to the
user. When the material is too large to read, read the parts that decide the
outcome, check the Worker's interpretation against them, and mark what you did
not check as provisional. A report a Worker wrote is evidence to verify, not a
conclusion to relay. The final report to the user is the lead's.

## Lead: work with a second opinion

The lead reviews deliverables itself unless the user requests a second opinion
for high-stakes work. A second opinion is a Worker on the `second-opinion` model
role with an independent perspective. It keeps its own judgment: a review Task
asks for a verdict and ranked findings, never for confirmation of a decision
already made. Answer disagreement with reasons; escalate unresolved disagreement
to the user.

Give the second opinion a reading bundle in Task prose: the goal in the user's
terms, the audience, deliberate constraints, and direct pointers to the
deliverable and the sources needed to judge it. Leave out the implementation
history and earlier Attempts, so it judges what a reader without that history
would see. The second opinion reports findings with a concrete simpler
alternative for each; repair stays with the builder through a failure route.
Reuse one second-opinion Worker for the Team. Create another only when the user
asks for a cold read of one deliverable, and stop it after that Task resolves.

## Lead: assign or revise the Task graph

Put the outcome, constraints, needed source pointers, and external success signal
in Task prose. An assigned Task is the work contract. Alerts carry exceptional
clarification or attention, not new assignments or Task state changes.

Use `task_graph_apply` for the complete intended graph. Keep keys stable for the
same Tasks and use new keys for new outcomes. Each revision replaces the current
set: include every Task that should remain current. Changes to Task goals,
assignments, or dependencies belong here, not in `current_context` or an Alert.
Use the graph version from the accepted apply receipt for a new revision; exact
retry rules are below.

Use `needs` when a Task must wait for another Task's successful result. Split off
useful early work before applying that dependency to the remaining work. Use a
bounded failure route when a failed check should return work for repair. The runtime
selects and delivers eligible Tasks, limits each Worker to one in-progress Task,
and advances success or repair paths. The leader does not manually dispatch each
successor. A failed Attempt can return its Task to waiting while repair runs.

## Lead: plan early starts

Reduce elapsed time to accepted results and useful learning. Look for both
opportunities when dividing work:

- Start independent Tasks together. Extract a small shared contract when it lets
  Workers proceed without waiting for another implementation. Backend and frontend
  work can share a protocol and feed a later integration Task.
- Start reversible parts of dependent work with preliminary inputs or explicit
  assumptions. Literature review and data analysis can start together. Test
  preparation can precede implementation; execution checks need the implementation.

Define an early Task's outcome as the useful work it can complete now. Put its
assumptions, source pointers, and required later checks in Task prose. Give the
later integration or validation Task the actual result dependencies. Early Task
success proves only its bounded outcome; it does not prove the combined result.
Keep necessary dependencies, scope, and owner approvals intact. State in an early
Task's prose which irreversible effects must wait for actual inputs. Resolve those
assumptions before the effect occurs.

Give Workers shared artifact pointers in Task prose. Ask them to publish useful
partial results there and record progress in `current_context`. Split out a
partial-result Task when another Task needs that verified output to start.
Revise the graph when Task outcomes or dependencies change within the agreed scope.
Escalate changes to the requested goal to the owner. Keep valid work. Use bounded
failure routes for failed checks, or add a repair Task for a new outcome. Keep
repair with the affected Worker and make later checks depend on the repaired result.
Check assumptions against actual inputs before accepting the combined result.

Account for Worker capacity, shared resources, human review, and rework when choosing
early starts. More active Workers help only when they reduce total elapsed time or
increase useful learning within the same budget.

## Lead: supervise and finish the request

Use `team_sync` updates for progress and waiting. Updates return a snapshot
when an observation baseline is missing. Mutation receipts already report post-state;
read again only when required meaning is missing, stale, or conflicting.

Use `team_sync({view:"updates"})` to wait while Workers can progress. The runtime
keeps one wait open across internal rechecks. After a lead reply, automatic sync
resumes the lead for a new batch of Team changes. Do not use sleep or repeated
empty sync calls to keep orchestration alive. `/teamsync` performs one immediate
human-requested check. An empty check does not start a model turn.

Handle returned changes and continue toward the requested outcome. Assigned
nonterminal Tasks can remain when all Workers are idle; use their current records
to decide what can proceed or what requires intervention.

`caught_up` means no new change is available and no current Worker producer
requires a wait. It does not mean every Task succeeded. `unsettled` lists Workers
whose activity or missing evidence needs attention. Use its reasons and current
Task records to identify a blocker or recovery need. A duplicate sync in one
message returns `refused`; use the other call's result. Read selected Tasks with `task_read` when needed.
Use terminal evidence for exceptional diagnosis, not as Task progress. State the
blocker and next actor when no actor can progress. Explicit owner pause or stop
instructions remain authoritative.

Report the requested outcome with evidence, or identify the blocker and next action.
Keep reusable Workers and the Team available. Stop a Worker only after its assigned
nonterminal Tasks resolve and its capacity is no longer needed. Shut down the Team
only when the owner explicitly ends or resets its durable boundary; reconcile first.

## Worker: execute the assigned Task

Use your runtime-provided Worker tools and claim an assigned ready Task before work.
Keep the selected model during work. Human model changes in Pi remain authoritative.
Record success or failure with external evidence. Use `block` for an external blocker
and `resume` when it clears. Follow the returned Task state after every transition.
Keep still-relevant execution context in `current_context`; use evidence for outcomes
and blockers. Send an Alert to the lead when exceptional clarification is needed.

For a fact-finding Task, deliver located sources with pointers and verified facts.
Separate what you observed from what you infer, and mark inference provisional.
Do not write the conclusion the lead must form. For a second-opinion Task, judge
the deliverable from the reading bundle and the sources it points to. Do not read
other Workers' Task context or Attempts before you record your verdict.

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
