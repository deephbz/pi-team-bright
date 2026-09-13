# Pi Team Bright skill: source-grounded interface review

## Review contract

Purpose: use Matt Pocock's skill guidance and the actual agent-facing implementation
to propose a clearer Pi Team Bright operating skill. This artifact records assessment,
not accepted policy. It does not authorize changes to runtime contracts, deployment,
or the packaged skill.

Base: `d5ed077f1ddc1af2b76aa104e3938a6481c2e20d` (`0.17.5` candidate).
Stage: hardening. Existing pending journals and evidence remain separate.
Matt skill source revision: `3cca18b368ae95cdbdebbff572ccafa662551015`.

The owner requested the `ask-matt` router. It routes this work primarily to
`writing-for-agents`, supported by `domain-modeling` and `codebase-design`.
Use their wording, terminology, and caller-interface methods; do not import their
tracker setup or document layout into this repository. No engineering build flow
or skill installation is needed.

Review questions:

1. What must a leader decide, and what does the runtime already do?
2. Which facts do tool descriptions, results, and Worker prompts actually expose?
3. Which wording can cause a wrong action, rather than merely spend extra tokens?
4. Which instructions should remain inline, move to conditional references, or be removed?

The previous [article review](2026-09-13-skill-review-openai-astra.md) remains historical
assessment and owns its completed retry/replacement probes. Reuse those unchanged
results rather than rerun them.

Architecture impact: none for this review. Proposed interface changes, if any, require
separate owner acceptance. Findings and the proposed operating structure follow.

## Selected Matt skills and their use

- `writing-for-agents` is the main method: organize instructions around caller
  decisions, keep related rules together, and use conditional links for exceptional
  branches. Read its `SKILL-MECHANICS.md` too. Keep this skill model-discoverable;
  it is an operating skill, not a user-only router.
- `domain-modeling` tests overloaded words against concrete scenarios and code.
  Here the important distinctions are Worker scope versus Task goal, Task identity
  versus graph revision, and Attempt outcome versus current Task state.
- `codebase-design` supplies the key test: an interface includes everything the
  caller must know, not just parameter schemas. Removing necessary ordering or
  failure knowledge from prose does not make the interface simpler.

No architecture survey, implementation flow, or extra skill installation is needed.
The source paths in the Matt repository are `skills/productivity/writing-for-agents/`
and `skills/engineering/{domain-modeling,codebase-design}/`.

## Source findings that change the recommendation

### Teach decisions left to the leader; leave automatic work in the runtime

The leader chooses goals, Worker scopes, dependencies, and failure routes.
Graph authority derives readiness and prevents two simultaneous in-progress Tasks
for one Worker. Orchestration publishes changes and delivers eligible Tasks without
another leader turn ([graph-control.ts](../../src/task-authority/graph-control.ts),
`selectReadyFrontier`, `claim`, and `complete`;
[graph-orchestration.ts](../../src/task-authority/graph-orchestration.ts),
`reconcileReady`). A blocked Task is not an in-progress execution slot.

Therefore, the skill should not imply that the leader manually starts each successor,
recreates repair Tasks, or treats one Worker as one Task. Use one small conceptual
example: a builder implements and repairs; a separate reviewer checks independently,
even though its Task waits for the builder. This preserves the accepted distinction
between parallel execution and independent judgment.

### The caller sees less than the catalog contains

[pi-registration.ts](../../src/model-tool-contract/pi-registration.ts) registers each
tool with its catalog `responsibility` as the description. It does not inject the
catalog's full use cases, exclusions, side effects, or examples. Those fields cannot
replace needed skill instructions merely because they exist in source.

Workers already receive the Task execution protocol in `before_agent_start`
([pi-team-session-adapter.ts](../../extensions/pi-team-session-adapter.ts), line 635).
They have a narrower tool surface: `task_read` takes a scalar ID, and Alerts target
the lead implicitly ([extensions/index.ts](../../extensions/index.ts), line 548).
Keep the root leader-oriented, with a short clearly labeled Worker section. Do not
copy leader call examples into Worker instructions. A second Worker reference file
has not yet earned its discovery and maintenance cost.

### Worker scope is exact reusable input, not a fresh paraphrase

`ensureLogicalWorker` compares the stored and supplied scope strings exactly
([teams.ts](../../src/utils/teams.ts), lines 746–771). A harmless paraphrase can cause
`name_scope_conflict`; the catalog's “materially different” wording is weaker than
the implementation. The normal skill should say to reuse the recorded name and
scope. A connected Worker needs a new Task, not another launch check.

The launch bridge reuses a bound carrier or resumes a recoverable bound Session;
new Membership creation is a separate path
([worker-launch-bridge.ts](../../src/team-authority/worker-launch-bridge.ts), line 158).
Stable Worker meaning and preserved Session context are related but not identical.

### Graph keys preserve Task identity across revisions

The skill calls keys “request-local.” In production, the key becomes the Task ID;
unchanged keys and definitions preserve accepted work across graph revisions
([graph-control.ts](../../src/task-authority/graph-control.ts), `applyGraph` and
`toView`; [durable-model-tool-task-application.ts](../../src/model-tool-contract/durable-model-tool-task-application.ts),
`createTaskGraph`). Renaming a key creates a different Task, not a harmless new
request-local alias. Applying a graph replaces its complete current Task set.

State the consequence: retain keys for the same Tasks, supply every Task intended
to remain current, and use new keys for new outcomes. Removing old terminal Tasks
from the current graph is different from erasing their history. Do not require
retaining all historical Tasks forever.

### Context is not a substitute for revising the goal

`current_context` appends execution context without changing the Task definition or
invalidating an accepted Attempt. Definition changes go through graph revision.
Even title changes participate in definition lineage in the current controller.
Keep the skill focused on the consequential rule: changes to goals, assignments,
or dependencies belong in the graph, not a context note or Alert.

### A failed Attempt is not always a terminal failed Task

A bounded failure route can reopen the implementation and return the failed review
to `dependency_waiting`. The `goal_failed` command reports an Attempt outcome; the
returned Task state includes the runtime's next derivation. A probe confirmed this.
The skill should tell the caller to follow returned state, not assume the command
name is the final Task status. No manual re-creation of the repair loop is needed.

### Observation needs a completion distinction, not cursor internals

`caught_up` means there are no unseen changes and no currently productive producer
requiring a wait. It can occur with unfinished Tasks. `indeterminate` means the
runtime lacks enough evidence to publish a new observation
([observation-service.ts](../../src/coordination/observation-service.ts), lines 102–216).
Neither establishes Task success. A literal “keep syncing until done” recipe can
produce a useless loop.

Replace hidden watermark explanations with the next decision: use current Task
state to distinguish complete work, blocked work, absent Workers, and uncertainty.
Use targeted reads or recovery for a specific gap, not normal terminal polling.

### Recovery guidance already belongs in returned results

The model projection emits `retry_same_operation`, `reconcile_and_retry`,
`request_snapshot`, and shutdown retry guidance
([result-projection.ts](../../src/model-tool-contract/result-projection.ts),
`projectOutcome`). Thus a blanket “read before every retry” duplicates and can
contradict the executable interface. Keep a concise unchanged-input retry rule and
follow the result's recovery action; omit Beads-specific backend instructions from
the normal path. Direct authority rescue remains an exceptional authorized branch.

One interface gap cannot be solved by skill wording: the public Team snapshot does
not return the graph version needed for a new graph revision. It appears in graph
apply receipts, but not the normal read projection. Do not promise that a snapshot
restores this coordinate. Preserve the receipt when available; separately consider
an explicit read projection for the current graph version. No tool change is
proposed as part of the skill-only edit.

## Proposed skill body for owner review

This is a candidate, not a replacement installed in `skills/`. Links below are
intended relative to the packaged skill directory. It keeps one normal workflow,
a short Worker branch, and the existing exceptional rescue reference. No arbitrary
word-count target governs the edit.

```markdown
---
name: pi-team-bright
description: Use when coordinating Workers or executing an assigned Task with Pi Team Bright.
---

# Pi Team Bright

A Team holds a durable project or coordination boundary. A Worker holds a reusable
scope and working context. A Task assigns one bounded outcome to a Worker.
These have separate lifecycles: finishing a Task does not end its Worker or Team.

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
or dependencies belong here, not in `current_context`. Use the graph version from
the accepted apply receipt for a new revision; exact retry rules are below.

Use `needs` when a Task requires another Task's successful result. Use a bounded
failure route when a failed check should return work for repair. The runtime
selects and delivers eligible Tasks, limits each Worker to one in-progress Task,
and advances success or repair paths. The leader does not manually dispatch each
successor. A failed Attempt can return its Task to waiting while repair runs.

## Lead: supervise and finish the request

Use `team_sync` updates for progress and waiting. Follow its request for a snapshot
when an observation baseline is needed. Mutation receipts already report post-state;
read again only when required meaning is missing, stale, or conflicting.

`caught_up` means no new change is available now, not that every Task succeeded.
`indeterminate` means observation evidence is incomplete. If work remains, use
current Task and Worker records to identify a blocker or recovery need rather than
repeat empty sync calls. Read selected Tasks with `task_read` when needed. Use
terminal evidence for exceptional diagnosis, not as Task progress.

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
```

## Verification and remaining uncertainty

New disposable controller probes confirmed:

- keeping keys and definitions across a revision preserves an accepted Attempt;
- a context-only update does not invalidate accepted success;
- failed review with a repair route returns review to waiting and repair to ready;
- renaming the implementation key produces a new Task with zero Attempts.

The executable [probe](artifacts/2026-09-13-skill-interface-probe.cjs) preserves
these cases. Run its documented command from the package root.

These are in-memory behavioral anchors, not model evaluations or production Team
runs. The earlier exact-retry and omission probes were reused unchanged. No broad
suite ran and no live Team was created. Source inspection anchors exact scope
matching, prompt injection, recovery projection, and sync outcome interpretation.

Before accepting the candidate, compare model actions on those same situations,
plus Worker reuse after context loss, blocked work, and request completion without
shutdown. Verify accepted operations and final Task state, not compliance with
particular wording. No reduction in model errors or token use is claimed yet.

The owner decision is whether the skill should primarily teach delegation judgment
and interpretation of results, while tools and Worker prompts own mechanical details.
The candidate assumes yes. A counterexample is any routine caller decision that
would now require reading implementation code; that knowledge must remain at the
interface rather than disappear in a shortening pass.
