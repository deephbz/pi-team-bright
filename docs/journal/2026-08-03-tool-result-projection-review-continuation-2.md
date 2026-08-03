# Projection cutover blocker repair continuation

Date: 2026-08-03

## Current work contract

Task `ptb-tool-result-projection-review-7xm` is assigned to `projection-implementer` and is in progress. Its accepted scope repairs the independent verifier blockers. Do not run tests while editing. After edits, run `npm run test:full` once; if it fails, fix the reported release-blocking class and rerun only that command. Then run `npm run qa:tool-results` once and inspect the fresh QA artifact. Do not run duplicate lanes.

## Prior evidence

The earlier implementation task closed after the focused gate passed: `npm run typecheck` and the four focused projection/catalog/registration files passed, 27 tests total. Independent verification then found a real bug: `team_shutdown` partial model projection retained raw `state_changed: true`, so validation threw and QA captured empty details. It also found stale full-suite expectations and current metadata wording/name references.

## Edits made for the repair task

- Added the first repair to strip `state_changed` from the `team_shutdown` partial model projection while retaining the true raw semantic detail.
- Added exact recovery variants for new-operation guidance and read-before-retry guidance.
- Replaced `team_sync` model `Type.Unknown` change arrays with exact Team, Worker, Task, and Alert schemas from the catalog.
- Added per-item Task update recovery for operation conflicts and version conflicts.
- Added task-link model recovery: reconcile at the exact current version when supplied, otherwise read before retry without fabricating a version.
- Improved TUI handling for mixed Task batches, partial Alert delivery, update-detail blockers, per-item recovery, and unfinished shutdown Tasks.
- Relaxed raw candidate Task update journal entries to preserve Worker receipts without synthesizing journal evidence; added raw delivery-warning preservation.
- Added raw terminal-evidence refusal vocabulary.
- Confirmed the accidental `.playwright-cli/` directory is present and must be removed before handoff.

## Still required

1. Finish `projectWorkerReceipt` so it preserves exact refusal reasons, real journal evidence, delivery warnings, and failed Alert recipients. It must not hard-code `version_conflict`, synthesize journal entries, or erase failures.
2. Fix `scripts/tool-result-qa/mine-history.ts` current-name references without rewriting historical JSON evidence; current mappings must expose `ensure_worker` while historical source names remain historical.
3. Replace the remaining identity wording in the generated review and active docs, then regenerate `docs/generated/model-tool-contract-review.html`.
4. Migrate or remove stale full-suite assertions in binding, ergonomic, Task-surface, and clean-cut tests. Preserve historical journals and decisions. Add current-source pointers if needed.
5. Remove `.playwright-cli/`.
6. After all edits, run exactly `npm run test:full` once, fix failures, and rerun only that command if needed.
7. Run exactly `npm run qa:tool-results` once. Inspect `artifacts/tool-result-qa/latest.json` for schema `/2`, nonempty raw details for shutdown partial, exact raw/model/collapsed/expanded projections, no false green/Accepted, no fabricated counts, no raw JSON echo, and no legacy warning.
8. Independent verifier must then review the exact tree. Global install remains blocked until that verifier passes. Do not publish.

## Release state

Version metadata was changed to `0.17.0-rc.2`. The owner smoke install Task remains blocked by independent verification. Do not install globally until the verifier closes successfully.
