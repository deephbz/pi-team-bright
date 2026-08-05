# Beads call-minimization final handoff

Date: 2026-08-05
Task: `beads-call-minimization-m5v` — Reduce mutation preflight calls
Worker: `mutation-path-implementer`

## Scope completed

This Worker implemented safe call reductions for the model-facing mutation
paths. The lower Beads mutation authority still performs its required locked
raw reads, expected-version checks, graph validation, post-write hydration, and
operation/publication handling.

For a newly committed candidate create, the exact post-create `bd show` record
now travels in the create receipt and the candidate adapter reuses it. Replay
receipts do not reuse compact idempotency-list records; they still perform a
detailed read because compact records do not carry relation identities.

For a multi-Task model update, the candidate adapter performs one exact-ID
batch hydration and the model port reuses each raw candidate record for its
independent update. If batch hydration fails or is incomplete, the code falls
back to the previous per-item chain. The underlying `applySemanticTaskUpdate`
path still passes the preflight raw version to the locked Beads update, which
reads the current raw record and rejects a stale version.

For `task_link`, the model port skips the duplicate outer source read when no
opaque expected version needs resolution. When an expected version ref is
supplied, the outer read remains so the ref can resolve and be checked. The
lower link authority still validates source and target, graph state, and the
final source revision.

For model-facing `worker_stop` and `team_shutdown`, lifecycle guards now use
compact `listTaskIds`, because their receipts need only guarding IDs. Legacy
receipts that expose detailed Task revisions retain `listTasksWithVersions`.

## Files changed for this Task

The following files contain this Worker's changes. Several also contain
concurrent Worker edits; the lead must review the combined hunks before merge:

- `src/utils/beads.ts` — create receipt carries exact candidate authority
  hydration; missing-aware batch candidate hydration is retained.
- `src/utils/tasks.ts` — create receipt propagation and compact `listTaskIds`.
- `src/model-tool-contract/beads-task-adapter.ts` — exact record reuse for
  create and update, plus raw batch preflight support.
- `src/model-tool-contract/durable-model-tool-port.ts` — batch update
  preflight reuse and no-version link read removal.
- `extensions/index.ts` — compact lifecycle ID guards in the model adapter.
- `src/model-tool-contract/beads-task-adapter.test.ts` — create reuse,
  missing-aware batch hydration, and update preflight reuse checks.
- `src/model-tool-contract/mutation-call-minimization.test.ts` — deterministic
  focused checks for multi-update hydration, no-version link reads, and compact
  lifecycle ID reads.
- `src/utils/release-p1-contract.test.ts` — lifecycle fixture uses the compact
  list seam.
- `src/utils/launch-compensation.contract.test.ts` — lifecycle fixture uses
  the compact list seam and preserves unfinished IDs.
- `src/utils/topology-lifecycle.contract.test.ts` — lifecycle fixture uses the
  compact list seam.
- `docs/journal/2026-08-04-beads-call-minimization-implementation-handoff.md`
  and `docs/journal/2026-08-05-beads-call-minimization-verification.md` —
  durable implementation and verification records.

Other uncommitted files in the checkout belong to concurrent Workers. Do not
reset or revert them. The lead must reconcile those edits with the files above.

## Verification evidence

Passed:

- `npm run typecheck`
- `git diff --check`
- `npx vitest run src/model-tool-contract` — 8 files, 66 tests.
- Adapter, durable-port, and minimization lanes — 3 files, 34 tests.
- Beads, publication, delivery, and Worker-version lanes — 4 files, 18 tests.
- Full-config release lifecycle lane — 15 tests.
- Full-config launch compensation lane — 13 tests.
- Full-config topology lifecycle lane — 3 tests.
- Full-config ergonomic lane — 16 tests.
- Full-config binding lane — 10 tests.
- Final adapter plus minimization rerun — 2 files, 19 tests.

A broad full-config run was not claimed. One unrelated concurrent delivery
projection test failed in `src/utils/clean-cut-contract.test.ts`; the failure
reported fallback text instead of the fixture's expected complete payload.
The shared checkout also has later concurrent edits that need one final
integration run.

## Risks and boundaries

- The Team authority remains mixed: the lead reports implementation `0.17.0-rc.4`
  while this Worker runs `0.17.0-rc.5`. `task_read`, Task mutation, and Alerts
  from this Session refuse with the mixed-version error. This Worker could not
  start, update, or close the Task through the authority.
- Batch preflight is not a compare-and-swap proof. The locked raw Beads read and
  expected-version check remain mandatory.
- Missing or unavailable batch hydration intentionally falls back to the old
  independent per-item path. This protects unknown outcomes but may not reduce
  calls for that failure case.
- The focused command-count tests use deterministic authority seams. The lead
  must review native Beads command traces and the final shared diff before
  publication.
- Concurrent delivery, projection, and schema-audit changes are present in
  the same checkout. This handoff does not certify those changes.

## Next action

Stop editing this shared checkout. The lead must reconcile the final tree,
resolve the single-version Team epoch, run the final broad verification lane,
and then close or block `beads-call-minimization-m5v` with this evidence. A fresh
single-version Team should continue any remaining integration or release work.
