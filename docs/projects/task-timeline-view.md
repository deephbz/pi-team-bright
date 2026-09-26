# Task timeline view

Stage: implemented; local verification complete.

The owner requested a waterfall timeline beside the default dependency DAG in
`/pi-team-graph`. Both views read the same Task authority. This change uses the
existing terminal pane and keeps Task selection, recent limits, and state
filters across the view switch.

The DAG answers which Tasks depend on each other. The timeline answers when
recorded Attempts started, blocked, resumed, and ended. Each retry has its own
row. Bars show elapsed calendar time; they do not measure model effort or
process liveness. Missing historical timing remains unavailable.

The graph authority records transition times alongside its ordered events.
Replay preserves them. The view derives intervals from those events and never
uses journal publication time as Attempt timing. No new store, scheduler,
model tool, or browser server is part of this change.

The isolated contribution starts at `70bfe4f` on `codex/task-timeline-view`.
That integration base contains the model-role and synchronization changes.
This change has no semantic dependency on either feature.

Architecture impact: changed inside Pi Team Bright. The Task authority gains
recorded transition timing; the existing read-only pane gains a second view.
HyperCarrier integration boundaries and public observation protocol stay the
same. Its canonical architecture treats Pi Team Bright internals as opaque.

Verification:

- The normal package lane passed 930 tests; three tests were skipped.
- Focused authority and Task-view checks passed 95 tests, including durable
  recovery, replay, old records, blocked/resumed Attempts, retries, cancellation,
  clock rollback, view switching, narrow terminals, and 240 Tasks.
- TypeScript and the fixed DAG render artifacts passed.
- The actual terminal pane opened in DAG, switched to Timeline, zoomed, and
  refreshed after its source file changed. The preview used recorded fixture
  transitions; it did not launch paid model work or mutate a live Team.

Independent product and systems observers reviewed the timing contract. They
identified the missing authority timestamps and cross-Attempt clock rollback.
Their final review and the delegated verifier stopped at a subagent usage cap.
The primary agent completed implementation review, regression tests, and the
terminal check. No release or live package adoption is claimed.
