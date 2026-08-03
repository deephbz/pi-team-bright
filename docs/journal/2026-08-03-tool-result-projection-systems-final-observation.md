# Tool-result projection systems final observation

Date: 2026-08-03
Commit: `599a17e7c2c7176b53dc4865cb3825a4568eb18e`

## Result

The central cutover is present and the earlier semantic defects are repaired in the recognized Worker adapter paths. `extensions/index.ts:373-443` preserves specific Task refusal reasons, current Task cards, journal evidence when present, and Alert failed recipients. `result-projection.ts:115` uses typed catalog-derived sync change arrays, `result-projection.ts:242-289` adds conflict and snapshot recovery, and `tui-projection.ts:47-89` renders per-item batch recovery. `src/utils/trace.ts:42-78` remains payload-free.

Systems acceptance is still blocked. Current executable stale identity checks remain in `scripts/probe-model-tool-vertical-slice.ts:72` and `scripts/model-tool-canary/run.mjs:598-607`. `src/utils/receipt-types.ts:1-66` remains a generic legacy-shell envelope, and `extensions/index.ts:365-431` still uses an `any` adapter with fallback returns for unrecognized receipts. This leaves Worker composition fail-open rather than proving one typed semantic authority.

The schema `/2` QA artifact exists at `artifacts/tool-result-qa/latest.json` with projection version `2` and 39 cases. Its update-requesting `team_sync` cases all contain `snapshot` results. The fixture's next observation is replayed by `durable-preview-port.ts:405-410` while pending observation state remains unacknowledged, so the artifact does not prove update, contract-gap, or cancelled projections. A fresh `npm run qa:tool-results` attempt timed out after 120 seconds without producing a new result.

No implementation or release-lane work was performed by this observer.
