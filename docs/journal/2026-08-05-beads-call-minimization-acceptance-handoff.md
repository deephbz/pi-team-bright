# Task cutover acceptance handoff

Date: 2026-08-05
Task: `beads-call-minimization-hh9` — Specify Task cutover acceptance
Worker: `cleanup-acceptance-designer`

## Scope result

No acceptance criteria were authored or applied. The canonical Task context was
unavailable because the Task authority rejected access from this Worker.

## Files changed

- Added this journal handoff only.
- No production files changed.
- No existing files were reverted or reformatted.

## Authority evidence

The following operations were rejected with the same mixed-version error:

- `task_read(team=beads-call-minimization, task=beads-call-minimization-hh9)`
- atomic `claim=true` for the Task
- `alert_send` for the Task

The Team authority is pinned to implementation `0.17.0-rc.4`, while this Worker
runs `0.17.0-rc.5`.

## Verification

No code verification was run because this read-only design Task could not be
started safely without its canonical context. The shared checkout was inspected
for concurrent changes; those changes were not modified.

## Risks

- Guessing acceptance criteria from the Task title could accept the wrong
  cutover boundary.
- The shared checkout contains concurrent uncommitted implementation and audit
  changes. A fresh Worker must not reset them.
- The mixed Team epoch can reject Task mutations and Alerts until the lead
  shuts it down and starts a single-version epoch.

## Next action

The lead must reconcile the Team epoch, then reread and claim this Task from a
fresh single-version Worker. That Worker should write the exact acceptance
criteria into the Task authority and close it with focused evidence, or block it
with the remaining decision and next action.
