# Beads call minimization implementation handoff

Date: 2026-08-05
Task: `beads-call-minimization-m5v` — Reduce mutation preflight calls

## Authority and shared-tree state

This Worker cannot read or mutate the Task authority. Task reads and Alerts
return the mixed-version error: Team `beads-call-minimization` belongs to
implementation `0.17.0-rc.4`, while this process runs `0.17.0-rc.5`. The lead
received an attention Alert. Do not claim, close, or conditionally update this
Task from this Session until the Team epoch is reconciled.

The checkout is shared. Other Workers added uncommitted changes while this
Worker worked. Do not reset or overwrite their files. Known concurrent areas
include durable model-tool snapshot/read hydration and cache changes,
missing-aware Beads hydration, Task-delivery projection changes, and related
tests/docs.

## Implemented in the shared working tree

- `src/utils/beads.ts` returns the exact post-create candidate authority record
  from the already-required committed `bd show` for a new create. Compact
  idempotency replay records do not provide a safe relation-aware version, so
  replay still uses the detailed adapter read.
- `src/utils/tasks.ts` carries that post-create record through
  `TaskCreateReceipt` and adds `listTaskIds`, which uses only the compact
  Team-scoped list for lifecycle guards.
- `src/model-tool-contract/beads-task-adapter.ts` reuses the create receipt
  hydration and exposes raw batch candidate records. Its update method accepts
  an optional preflight record. The underlying mutation authority still reads
  the raw Task under its lock and checks the expected raw version; reuse only
  removes the duplicate metadata read.
- `src/model-tool-contract/durable-model-tool-port.ts` hydrates unique update
  candidates once, reuses found records for independent updates, and falls
  back to the old per-item chain when exact batch hydration is unavailable or
  incomplete. `task_link` skips its outer source read only when no opaque
  `expected_version` needs resolution. Supplied version refs retain the old
  preflight chain because the lower authority still needs a raw version check.
- `extensions/index.ts` uses compact `listTaskIds` for model-facing
  `worker_stop` and `team_shutdown`; legacy receipts that expose detailed Task
  fields retain `listTasksWithVersions`.
- Added focused coverage in
  `src/model-tool-contract/mutation-call-minimization.test.ts` for batched
  update preflight reuse, no-version task-link read removal, and compact
  lifecycle ID guards. Extended candidate adapter tests for create hydration
  and update preflight reuse.

## Evidence already run

- `npx vitest run src/model-tool-contract/beads-task-adapter.test.ts`
  passed: 16 tests.
- `npx vitest run src/model-tool-contract/durable-model-tool-port.test.ts`
  passed: 14 tests before the latest local update-preflight edits; rerun it.
- Combined adapter plus durable-port focused lane passed 31 tests after the
  local edits.
- `first-journey` plus ergonomic/launch/binding focused run passed 19 tests.
- `npm run typecheck` failed only in a concurrent
  `durable-model-tool-port.test.ts` edit: lines 408 and 428 inferred a Map
  status as literal `"open"`, rejecting `"in_progress"` and `"blocked"`.
  The owning Worker must fix or cast that fixture before final verification.
- The new mutation-call-minimization test has not run yet.

## Continuation actions

1. Reconcile the shared working tree with the other Workers. Keep their
   changes; inspect the final diff for overlapping hunks.
2. Fix or have the owning Worker fix the two concurrent fixture type errors.
3. Run the new focused mutation-call-minimization test and the adapter,
   durable-port, task-link, lifecycle, and relevant Beads lanes.
4. Recheck that the new batch preflight preserves independent outcomes,
   operation replay, version conflicts, unknown outcomes, and no-write gaps.
5. Verify real Beads command traces for create/update/link/lifecycle counts;
   do not claim a reduction from prose or a test-only call count.
6. Report exact evidence to the lead, then let the authority update/close the
   Task after the version epoch is fixed.
