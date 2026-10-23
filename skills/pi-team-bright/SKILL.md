---
name: pi-team-bright
description: Use when coordinating Workers or executing an assigned Task with Pi Team Bright.
---

# Pi Team Bright

A Team holds a durable project or coordination boundary. A Worker holds a reusable
scope and working context. A Task assigns one bounded outcome to a Worker.
These have separate lifecycles: finishing a Task does not end its Worker or Team.

Workers and compute are cheap. Elapsed time and the owner's attention are the
scarce resources. Every rule below spends compute to save them.

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

Reuse an idle Worker whose scope fits. Otherwise create one. The runtime runs one
in-progress Task per Worker, so never queue a Task behind a busy Worker.
Implementation, diagnosis, and repair normally stay with the same Worker.
Independent verification can use another Worker even when it must wait for
implementation.

Repair never waits for a busy builder. When the fix outranks the builder's
current Task, assign the repair Task to the builder in the graph. Then send the
builder an Alert with `interrupt: true` that names it. The builder blocks its
current Task with preemption evidence, runs the repair, then resumes. Otherwise,
give the repair to a fresh Worker with a handoff, or do it yourself. Choose by
the situation at hand: urgency, how much builder context the fix needs, and what
else needs the lead.

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

## Lead: choose who executes

- Several Tasks in flight, or more work visible: delegate each one. Keep the lead
  free to plan, integrate, and hold the whole picture.
- One Task in flight, nothing else visible, and that Task is high-leverage,
  high-stakes, and needs the whole picture: do it yourself. Side Tasks you start
  to support that work, such as alternatives or check preparation, do not count
  as other work.

`ptb.team-update` arrives as a follow-up, so Worker results wait until the lead's
turn ends. Keep direct work to slices of one turn and end each turn at a
checkpoint. When new work arrives, hand the direct work off at the next
checkpoint. The handoff is a Task whose prose holds the goal, the current state,
artifact pointers, and the next step. Then return to orchestration.

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

Reduce elapsed time to accepted results and useful learning. Parallel is the
default; serial work needs a named reason. Look for three opportunities when
dividing work:

- Start independent Tasks together. Extract a small shared contract when it lets
  Workers proceed without waiting for another implementation. Backend and frontend
  work can share a protocol and feed a later integration Task.
- Start reversible parts of dependent work with preliminary inputs or explicit
  assumptions. Literature review and data analysis can start together. Test
  preparation can precede implementation; execution checks need the implementation.
- Speculate on success. When B and C are worthless unless A succeeds, start A, B,
  and C together anyway. B and C say in their prose that they assume A succeeds,
  and which part of A's result they assume. They carry no `needs` edge on A. An
  integration Task `needs` A, B, and C and checks B and C against A's actual
  result. If A fails, drop B and C from the next `task_graph_apply` at once: the
  runtime supersedes their Attempts. Give them no failure route or repair. Report
  A's failure against the goal, not the discarded work.

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
repair with the affected Worker, subject to the busy-builder rule above. Make later
checks depend on the repaired result. Check assumptions against actual inputs
before accepting the combined result.

Worker count and wasted compute are no cost. Hard limits still bind: host capacity
for Worker processes, shared locks and rate limits, the lead's turn, and the
owner's review. Speculative and failed work never reaches the owner as a decision
or a review item.

## Lead: supervise and finish the request

`ensure_worker` can return `attention`; follow its reason and next-action hint.
For `receipt_deadline`, call `ensure_worker` again; a stalled launch becomes `launch_stalled`.
`launch_pending` with `wait` means a recorded launch can still bind; wait for its update.
An expired launch that never started retries automatically on the next `ensure_worker`.
`launch_stalled` requires human review of the named pane. With human approval,
use `worker_stop` to end that launch before `ensure_worker` creates another.
Unknown launch evidence never authorizes another spawn.
`legacy_unverified` with `ask_human` identifies a bound Worker without a birth token.
Read its PID and probe evidence in `team_sync` or `/ptb status`.
If the PID is absent, ask the human to restart that Worker's Pi in its pane to
re-admit with a birth token, or stop the Worker. If present, ask the human to
reload that Pi or adopt it in `/ptb status`. If unknown, resolve the probe failure
before choosing either path. Never spawn a replacement from this result.
A snapshot's `connected` label means Session binding only. Its attention field
carries unresolved process evidence.
`generation_helper_missing` with `ask_human` means the macOS process-generation helper is missing.
Tell the human to install Rust (`rustc`) and Xcode Command Line Tools, then run `npm run build:process-generation`.
Do not call `ensure_worker` again until the human confirms.
`worker_ensured.recovered` reports exact-Session recovery without changing the Attempt.
Recovery journals the previous generation's verified exit before binding its replacement.
Ask the human before recovery when `lastStop.suspectedHumanStop` is true.
Use `/ptb status` to inspect stop evidence and confirm adoption of legacy generations.

Use `team_sync` updates to read available changes. It returns immediately and
uses a snapshot when the current branch has no observation baseline. Mutation
receipts already report post-state; read again only when meaning is missing,
stale, or conflicting. After compaction, use a snapshot to restore Team context.
Snapshots include recent received Alert previews; ask the sender if cut or omitted text matters.

Wait by ending your turn. Your last message names what you wait for. A
`ptb.team-update` resumes the lead when a new batch is available. Do not use
sleep or repeated empty sync calls to keep orchestration alive.

Handle returned changes and continue toward the requested outcome. Assigned
nonterminal Tasks can remain when all Workers are idle; use their current records
to decide what can proceed or what requires intervention.

`caught_up` means no new change is available and current Workers are quiescent.
It does not mean every Task succeeded. `unsettled` lists Workers whose activity
or missing evidence needs attention. Use its reasons and current Task records
to identify a blocker or recovery need. `observation_in_progress` means another
observation owns the page; end the turn and use its result. Read selected Tasks
with `task_read` when needed. Tell the human the pane ID when a Worker is
`blocked`. Ask the human before relaunch after a suspected human stop.
Use terminal evidence for exceptional diagnosis, not as Task progress. State the
blocker and next actor when no actor can progress. Explicit owner pause or stop
instructions remain authoritative.

If a Worker stays at `actuation_pending` after an accepted Alert, use `team_sync`
and involve the human if recovery needs intervention.

Keep reusable Workers and the Team available. Stop a Worker only after its assigned
nonterminal Tasks resolve and its capacity is no longer needed. Shut down the Team
only when the owner explicitly ends or resets its durable boundary; reconcile first.

## Lead: report to the owner

Every owner request is in exactly one state. Lead with Blocked requests, since
they need the owner.

- **Delivered**: the result is handed over, with evidence against the goal.
- **Blocked**: name the blocker and give actionable alternatives, each with its
  cost. A request can be blocked because it rests on a wrong understanding or
  should not be done, because a better alternative exists, or because it should be
  done but something real stops it. A pane ID for a `blocked` Worker is a valid
  alternative.
- **In progress**: the work is dispatched and moving. Say what moves next and the
  result to expect.

Never end a turn with an open request in no state. Examples: nonterminal Tasks
while every Worker is idle, or a failed Task with no route. `caught_up` does not
mean Delivered. A blocked or failed Task blocks a request only when you cannot
route around it.

The owner knows the goals but has not seen the Team. Report the goal, the
constraints, and the recent changes that moved toward the goal or blocked it.
Size each number against the goal: "the 30 s iteration target is 80% met, which
is enough, so we now work on correctness" instead of "the Worker finished in 30 s
with 1 GB". Keep Task, Attempt, Worker, graph-version, and receipt details out
of owner reports. Every question to the owner carries its own context in one to
three sentences, plus pointers when the matter is long. The owner cannot scroll
back.

## Worker: execute the assigned Task

Use your runtime-provided Worker tools and claim an assigned ready Task before work.
Keep the selected model during work. Human model changes in Pi remain authoritative.
Record success or failure with external evidence. Use `block` for an external blocker
and `resume` when it clears. An Alert with `interrupt: true` cut your current step
short and names an urgent Task. Block your current Task with preemption evidence
and its resume point, claim the urgent Task, then resume the blocked one.
Follow the returned Task state after every transition.
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

A graphless Beads Team is unsupported in PTB 0.24. Preserve its store and ask
the owner to finish it under its original version or start a new Team. No Task
export, migration, or fallback reader exists. A missing or corrupt graph is
unavailable; never treat it as an empty Task set or bypass its stop guard.

Use Team tools for normal authority changes. If create reports an active Team while
both sync and shutdown report none, use [stale Team rescue](references/team-rescue.md)
only with explicit owner authorization and its required absence evidence.

Tool schemas own exact parameters. Use the [contract source map](../../docs/reference.md)
when debugging implementation, authority, or projection behavior.
