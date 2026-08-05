# Task-domain cleanup Worker handoff

Date: 2026-08-05
Worker: `task-domain-cleanup-implementer`
Assigned Task: `beads-call-minimization-7bz` — Cut over canonical Task domain

## Authority status

This Worker could not read, claim, update, or close the Task. The Team authority
rejects this Session because Team `beads-call-minimization` belongs to
implementation `0.17.0-rc.4`, while this Worker runs `0.17.0-rc.5`.

The lead must reconcile the Team into one implementation version before any
Task mutation. Do not infer closure from this handoff or from the delivered
Task-change snapshots.

## Shared-tree work completed by this Worker

The checkout is shared. Other Workers also changed these files. The edits below
are the edits made or corrected by this Worker during this Session:

- `src/utils/task-delivery.ts`: export the canonical `projectTaskForAgent`
  projection helper so recovery evidence can store a complete
  `TaskChangeTaskProjection`; preserve legacy raw snapshots only as fallback.
- `src/utils/tasks.ts`: use the canonical projection helper when recording
  enqueue-failure recovery evidence.
- `src/utils/task-delivery.test.ts`: assert the canonical `taskProjection`
  status instead of requiring the optional legacy `taskSnapshot`.
- `src/utils/clean-cut-round2.test.ts`: assert canonical ownership-loss
  projection data instead of requiring the optional legacy snapshot.

Do not reset or overwrite concurrent changes in the remaining modified files.

## Verification

- `npm run typecheck` passed.
- Focused Vitest run passed 29 tests across task delivery, candidate adapter,
  mutation call minimization, and related fast tests.
- `git diff --check` passed.
- The exhaustive clean-cut lane excludes `src/utils/clean-cut-round2.test.ts`
  under the default fast Vitest configuration; a direct run was therefore not a
  valid test invocation and reported no test files.

## Risks and limits

- This Worker did not run the broad release lane.
- The shared tree contains concurrent implementation, test, audit, and native
  Beads probe changes. The lead must review the final combined diff.
- The mixed Team epoch prevented Task evidence mutation and prevented a durable
  Task close from this Session.
- Canonical projection delivery still has legacy snapshot compatibility paths;
  the lead must confirm those paths against the accepted Task-domain contract.

## Next action

The lead should verify the shared-tree diff and focused evidence, reconcile the
Team epoch, then update or close the assigned Task from a fresh compatible
Session. This Worker stops editing after this handoff.
