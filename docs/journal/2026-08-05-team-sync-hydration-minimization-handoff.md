# Team-sync Task hydration minimization handoff

Date: 2026-08-05
Task: `beads-call-minimization-d4p`
Status: implementation complete; Task authority mutation refused by the mixed rc.4/rc.5 Team epoch.

## Scope completed

`team_sync` now reads Team events before Task authority hydration. A snapshot
continues to use the established complete authority observation: one Team-scoped
candidate `list` and one multi-ID `show`.

For updates with Task events, the durable port hydrates only the Task IDs named
by those events. A Worker-only structural event reads no Task authority records.
Events wake the read; they do not supply Task current state.

For a quiet event journal, the port retains a complete list-plus-multi-ID-show
observation. This detects external Task-authority changes that have no Team
event. It reports only changed Task IDs in the update projection.

The in-memory complete projection cache is not Task authority. The port stages
it with the pending observation and installs it only after hidden-observation
acknowledgement. A failed, cancelled, or unacknowledged observation cannot move
the cache baseline.

## Files changed for this Task

- `src/model-tool-contract/durable-model-tool-port.ts`
  - Added event-ID Task hydration and quiet full-rescan behavior.
  - Added acknowledgement-gated complete projection cache handling.
  - Preserved projection warnings in no-event Task deltas.
- `src/model-tool-contract/durable-model-tool-port.test.ts`
  - Added snapshot, immediate Task-event, quiet no-event, structural-event,
    waiting-update, and authority-failure scope checks.

This shared worktree contains concurrent changes in these files. Reconcile the
Task-specific diff before any commit.

## Verification evidence

- `npx vitest run src/model-tool-contract/durable-model-tool-port.test.ts -t 'hydrates only Task IDs named by events|does not stage an update'`
  - Passed: 2 tests.
- `npx tsc --noEmit`
  - Passed.

A full run of `durable-model-tool-port.test.ts` had one unrelated concurrent
fixture failure: its mocked ordered missing record did not match requested ID
order. Do not treat that failure as verification of this sync-path change.

## Risks and next action

The quiet no-event path still needs the complete authority read. This is the
safe subset because Beads list data cannot prove every detailed Task-version
change. Do not replace that read with events or list-only revision comparison
without backend equivalence evidence.

The current Team epoch refuses Worker Task mutations and Alerts due to its mixed
implementation version. The lead must reconcile shared-tree edits, run final
independent verification, resolve the Task in a fresh single-version epoch, and
then stop this epoch.

Architecture impact: none. This changes internal read selection only. Task
authority, public schemas, component boundaries, and topology are unchanged.
