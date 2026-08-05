# rc.6 gate repair continuation handoff

Date: 2026-08-05
Task: `rc6-release-final-2e2`
Status: in progress; do not close yet.

## Contract and evidence

The failed rc.6 gate had 12 failures across 7 files, with 65 passed files and 567 passed tests. The exact saved failures are preserved in the Task current context. The allowed work is focused repair only: no aggregate lane, pack, VCS mutation, workflow, release, or publication.

## Repairs completed in the current tree

Classified and repaired the following owning invariants:

- QA snapshot fixture no longer reads removed `TaskCard.relations`; relation assertions now rely on task-link results and canonical snapshot fields.
- QA fixture uses the canonical authority adapter and projector, raw authority versions for low-level writes, and explicit operation IDs for Worker updates.
- Clean-cut and round-2 fixtures now create canonical metadata and pass the adapter-owned `projectTaskCard` for owner-transition publication.
- Recovery retention fixture now keeps `taskVersion` equal to the canonical projection version.
- Ergonomic and clean-cut fixtures now pass opaque `TaskVersionRef` values directly instead of hashing an already-opaque ref.
- Clean-cut Worker fixtures now use current `current_context`, `journal_entries`, and `operation_id` fields. Their evidence assertion reads notes separately from current context.
- `BeadsTaskAdapter.createWithReceipt` now passes `projectTaskCard` through injected authority publication, preserving one create delivery while replay does not republish. The replay fixture strips the post-state card to retain its injected read-fault compatibility seam.
- `applySemanticTaskUpdate` no longer treats adapter bookkeeping metadata as a second mutation when `claim=true`.
- `BeadsTaskAdapter.update` now returns a typed `task_metadata_invalid` contract gap for oversized context instead of throwing before the authority call.

## Focused evidence

The focused clean-cut round-2 failures passed: 5 passed, 11 skipped.
The focused round-2 contract failures passed: 2 passed, 7 skipped.
The focused ergonomic lifecycle failure passed: 1 passed, 15 skipped.
The clean-cut E2E reached later stale fixture expectations and was repaired incrementally. Its latest remaining failure expects the deferred-status `task_read` call to throw, but the current public surface correctly returns a typed `unavailable` result with reason `task_authority_unavailable`; update that fixture expectation, then rerun only the exact test.

The QA suite reached later canonical snapshot assertions after earlier repairs. It still needs one final focused run after the relation and operation-ID fixture repairs. The test-generated ignored `artifacts/tool-result-qa/latest.json` may need removal before freeze.

The lock race failure remains classified as an environment fault: the fixture requires the package-local `node_modules/ts-node/register/transpile-only` path, which is absent in this checkout while the workspace-root dependency exists. Do not change lock implementation for this environment-only failure.

A temporary untracked config was created at `vitest.rc6-focused.config.mts` for exact-file focused runs. Remove it before handoff. Debug logging added during diagnosis was removed.

## Next actions

1. Update the deferred-status expectation in `src/utils/task-surface-cleancut.e2e.test.ts` to assert the typed unavailable result.
2. Run the exact clean-cut E2E test with the temporary focused config.
3. Run the exact QA test once more and remove ignored generated agent-surface evidence if required.
4. Run the narrow adapter tests covering create publication and oversized update.
5. Remove the temporary config and record final exact counts.
6. Check diff and content-tree manifest only; do not run aggregate, pack, VCS, workflow, release, or publication actions.

Architecture impact remains **none**. The changes preserve canonical `TaskCard`, opaque `TaskVersionRef`, historical evidence, and Beads-call boundaries. The rc.6 receipt needs a focused-repair effect entry after final checks; its release and publication evidence remains pending.

## Final focused evidence

The deferred-status expectation now checks the typed unavailable result. The exact clean-cut E2E passed: 3 passed. The exact QA suite passed: 1 passed; it emitted the expected synthetic delivery-warning stderr and wrote ignored agent-surface evidence, which was removed before freeze. Narrow adapter coverage passed: 3 passed, 12 skipped. The idempotent Worker create replay passed: 1 passed, 3 skipped.

The lock race was repaired as a fixture environment invariant: the worker now resolves the workspace-installed `ts-node/register/transpile-only` with `createRequire(import.meta.url)` instead of assuming a package-local path. The exact lock race file passed: 5 passed. The temporary focused Vitest config was removed. `git diff --check` passed. Final content manifest recipe: `git ls-files -co --exclude-standard -z`, exclude this handoff file, sort paths, append each path and SHA-256 of its bytes, and use `MISSING` for absent tracked paths; SHA-256 `68dd026f229d6072fccd024b586711d7e3e2e73e86e7a6680df83b083ad55784`.

## Generated declaration acceptance continuation

`npm run build:observation` reproduced `dist/utils/models.d.ts` byte-for-byte across two builds. Its accepted binary diff SHA-256 is `e79bde408aaab1afefba67f57a7ff77af6d35719c591ca5e3132e4c96be02a17`. The generated type-surface probe passed for `TaskVersionRef`, `TaskTeamEvent`, `TaskEventChange`, and alert Task references. The focused generated verifier now accepts only this frozen diff and the two deterministic ignored support files emitted for the declaration import; it rejects every other generated delta. The package verifier itself passed without invoking pack; the package command remains lead-boundary work because the assigned Task forbids pack.
