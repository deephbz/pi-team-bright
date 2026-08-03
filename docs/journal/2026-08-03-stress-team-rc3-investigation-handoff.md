# Active rc.3 stress-team investigation handoff

Date: 2026-08-03
Team: `stress-team`
Runtime version: `0.17.0-rc.3`
Evidence cutoff: `2026-08-03T14:52:50.306620Z`

## Scope and evidence

The Team was still active at the cutoff. This result is an immutable prefix
analysis, not a final run receipt. I read Team config, event, runtime, and Pi
Session records without controlling a pane or invoking Beads against the live
authority. Raw records remain private in place. Sanitized derived counts and
source digests are in
`docs/journal/artifacts/2026-08-03-stress-team-rc3-prefix-analysis.json`.

The Team had ten logical Workers, 11 active Memberships including the lead, and
ten ready Worker runtime records. The analyzed Session prefixes contained 11
of 11 configured Sessions.

## Simple improvements applied

The stress prefix showed ten identical Worker execution errors because every
Worker combined `claim=true` with `status=in_progress`. The runtime correctly
rejects this compound mutation, but the Worker schema description did not state
the composition rule. The Worker `task_update` description and `claim` field
now say that claim is atomic and must be sent alone. They also tell the Worker
to use the receipt's version for the next mutation.

The operating skill now states these retry rules:

- create a new Team before its first `team_sync`; sync does not create or
  discover a Team;
- retry a timed-out read;
- treat a mutation timeout as unknown, read current authority first, and only
  then retry with the same operation identity and semantics;
- retry Task-create `unknown_outcome` with the same operation ID and identical
  input.

The packaged Skill directory and frontmatter name are now
`pi-team-bright`. README, agent entry point, evergreen context, source map, and
the focused surface test point to the new name. An explicit Pi RPC load exposed
`/skill:pi-team-bright`, and package dry-run contained the new path but not the
old path.

## Nontrivial defect: exact create replay compares mutable state

Three Task-create operations returned `unknown_outcome` and were retried with
exactly the same input. Each repeated operation had one unique canonical input
hash. One retry returned the existing Task as created. Two returned
`operation_conflict` even though their retry payloads were identical.

The differing outcome tracks Task evolution, not input identity. One conflicted
Task had already closed before replay validation. The other remained initially
unchanged shortly before the retry batch, but changed while the sequential
batch handled the first item. The third Task had not evolved and replayed
successfully.

`CandidateBeadsTaskAdapter.createWithReceipt` currently identifies replay by
reading the current Task and comparing title, assignee, goal, current context,
and operation metadata with the initial state
(`src/model-tool-contract/beads-task-adapter.ts`). Current context and assignee
are mutable. Therefore an exact operation replay can become a false conflict
when its successfully created Task starts work before reconciliation.

Do not patch this by removing selected comparisons. Every initial semantic
field can evolve. The repair needs an immutable Team-scoped create fingerprint
persisted atomically with the idempotency key. Replay must compare the supplied
fingerprint with that immutable record, then return current Task state. The
design must define old records without a fingerprint, external writers,
operation-key collision, and a timeout before or after fingerprint persistence.

Required focused acceptance cases:

1. Create commits, the post-create read fails, and the Task later changes.
   Exact replay returns the current Task without a second create.
2. The same operation ID with changed initial semantics refuses after Task
   evolution.
3. A timeout during `bd create`, `show`, or replay `list` has an explicit,
   retry-safe outcome.
4. Concurrent Worker mutation between items in one create-retry batch cannot
   change replay identity.

A second persistence gap exists beside replay identity. All 13 unknown creates
were retried. Seven returned a Task and six returned `operation_conflict`.
Four returned Tasks still had no Task-creation event. The unchanged
`op-s-t56` replay is one direct example. `createTask` deliberately does not
republish an idempotent replay, because it cannot distinguish a fully published
create from an authority commit that failed before event and delivery
publication (`src/utils/tasks.ts`). Thus an exact replay can recover the Task
card but leave assigned work undiscoverable through the normal event/delivery
path.

The repair needs durable create-publication state or an outbox coupled to the
immutable operation fingerprint. Replay must complete missing publication once,
without duplicating an already published event or delivery. Add focused cases
for failure before publication, failure after publication, and recovery racing
normal Worker mutation.

These are persistence, idempotency, and delivery contracts. Per the owner's
rule, no implementation change was made.

## Capacity and availability findings

At the cutoff, 77 outcomes contained Beads timeouts: 64 `show`, nine `update`,
one `create`, and three `list`. All ten Workers and the lead observed at least
one timeout. Task-create returned 13 typed `unknown_outcome` results. Worker
tools exposed 61 additional timeout execution errors; two sync gaps and one
link refusal also carried timeout evidence.

At the prior cutoff, eight of ten version-conflict refusals immediately followed
a timeout on the same Task. This supports reconcile-before-retry guidance: the timed-out mutation
can commit even when the Worker lacks its post-state version.

All ten 16-item create batches completed. Their service times were 112.615 to
148.844 seconds, with a 122.3505-second median and 1,254.923 accumulated
seconds. This prefix does not establish a final error rate or capacity limit.

A backend or concurrency repair is nontrivial. It must compare process startup,
embedded Dolt contention, operation batching, command timeout, and unknown-write
reconciliation. Do not increase the timeout alone or add a global lock without
measuring queue time and recovery semantics.

## Nontrivial sync and refusal classification findings

Two snapshot attempts failed on one bulk Beads `show` hydration and returned
`contract_gap` reason `structured_task_event_evidence_absent`. The message
contained authority-timeout evidence, not missing structured event evidence.
The reason therefore misclassifies availability as an event-contract defect.
An updates call then correctly returned `snapshot_required` and did not advance
the hidden baseline. A two-Task read succeeded, which isolates the failure to
bulk hydration rather than all Task reads.

The first `task_link` attempt timed out during a Task read but returned
`graph_conflict`. A later retry with fresh state succeeded. Timeout is neither a
graph conflict nor evidence that a relation is invalid. Correcting these public
reason unions and recovery actions is a contract design change, so no code
change was made.

Snapshot hydration currently reads the full Task set through one Beads `show`.
The repair needs bounded pages or resumable batches, an incomplete-read marker,
and no baseline advance until every page is coherent. It must preserve the
successful small-Team path and distinguish unavailable authority from malformed
Task-event evidence.

## Controls that held

The prefix contained 154 created Task outcomes, 285 updated Task outcomes, 192
found reads, and 22 accepted Alerts. The event journal contained 634 unique,
strictly contiguous cursors from 1 through 634: 20 Worker, 592 Task, and 22
Alert events. Task evidence included 156 creates, 145 each of assignment,
progress, and status, and one relation. Worker Alert fanout succeeded under
load, a small Task read succeeded, and a relation retry succeeded.

Successful snapshot and incremental observation, complete DAG construction,
Worker summaries, stop, and shutdown remained unassessed at the cutoff.

Architecture impact: **none** for the applied Skill, descriptions, and test.
The deferred create-replay and authority-contention changes can affect
persistence and Task authority, so they require separate design and architecture
classification before implementation.
