# Decision 0010: DAG-native Task creation and mechanical dispatch

Date: 2026-08-09
Status: accepted for the isolated prototype; port after semantic hardening

## Decision

Keep Task as the work ontology. Replace independent model-facing create items
with one atomic DAG-aware `task_create` operation. A request supplies one
operation identity and assigned Tasks with optional request-local prerequisite
keys in `tasks[].needs`. One Task is the one-node case.

Remove `task_link` and existing-Task graph expansion from the normal model-facing
surface. The backend adapter maps each local prerequisite to one Beads `blocks`
edge from dependent to prerequisite. Pi Team Bright owns graph-operation replay,
Worker validation, Task metadata, delivery, and projections. Internal Task
authority can retain existing-graph operations without exposing their grammar in
the frequent model verb.

Assign each Task to at most one stable Worker. A Worker can own many Tasks, but
Task authority presents at most one eligible Task at a time. Different Workers
can receive the same ready front in parallel. Delivery does not claim work. A
Worker explicitly claims the exact Task, and active blockers refuse that claim
with blocker IDs.

`team_sync` observes committed state and readiness changes. It never schedules
or advances the graph.

## Motivation

This shape lets a leader state the full work order once. Mechanical dependency
and slot rules then advance normal handoffs without leader model turns. The
schema embeds Make-like `needs` keys in each Task and translates without semantic
inversion at the Beads boundary.

Atomic graph creation removes partial initial workflows. Request-level replay
prevents native Beads graph retries from creating duplicate nodes. Stable
single-Task ownership avoids shared mutable responsibility while supporting
many Tasks across fewer Workers.

## Consequences

The leader surface has nine tools. Task cards add outgoing relations and a
derived dependency state. Atomic local graph creation requires a breaking
model-tool contract and a new implementation epoch.

Task authority must persist delivery intent before Session actuation and must
reconcile after graph creation, Task mutation, Worker reconnection, and restart.
The prototype proves the policy and current Beads translation. The post-refactor
port must close the remaining graph-commit-to-event outbox crash window before
release.

## Reversal criteria

Revisit this decision if real model traces show that `needs` causes systematic
edge inversion, or if Beads cannot keep graph creation atomic across supported
platforms. Revisit one slot per Worker only if exact Session evidence proves
safe concurrent Task contexts without hidden work-state coupling.
