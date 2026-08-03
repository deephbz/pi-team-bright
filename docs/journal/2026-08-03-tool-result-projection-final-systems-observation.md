# Final systems observation: model tool projection

Date: 2026-08-03
Commit: `3f6e4d6cd5e48ff219e5430d250f0a1195d18a0b`

## Result

The real-Pi composition blocker is repaired. Worker launch uses `-ne -e` with the exact extension. Worker Session `019fc571-82ed-745d-80dc-a38b384641a5` made two successful `task_update` mutations. Leader Session `019fc571-068e-7e0e-961f-b968c44c4401` received both as typed `team_sync` updates without `contract_gap`.

A release blocker remains. `scripts/model-tool-canary/run.mjs:598-607` still defines `modelContentEqualsDetails` by requiring model content to equal raw `details`. The current assembler intentionally projects different model content: `src/model-tool-contract/result-projection.ts:205-210` hashes authority Task versions for model output while raw details retain full authority versions. The canary therefore retains a stale identity assertion and can reject the valid projection boundary.

The tracked generated review remains stale. `src/model-tool-contract/render-review-html.ts:91-93` generates separate model and raw sections, but `docs/generated/model-tool-contract-review.html:132-197` still shows old authority versions such as `task_v7` and `task_v8` in model examples instead of the current `v_` references. Regenerate this derived artifact before release.

The Worker semantic adapter now fails closed for unknown legacy receipts and uses runtime narrowing (`extensions/index.ts:353-513`), so the real-Pi proof supports leader/Worker composition. The registration shell still uses dynamic Pi casts (`extensions/index.ts:543-561`), and `src/utils/receipt-types.ts:1-66` remains an internal generic legacy receipt representation used by current shell paths. These are typed-boundary and deletion-test concerns, but they did not fabricate the observed real-Pi outcomes.

Trace privacy remains satisfied by the payload-free record contract in `src/utils/trace.ts:42-78`. No suite or release lane was run for this observation, per the accepted testing policy.
