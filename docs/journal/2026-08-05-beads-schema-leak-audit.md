# Beads schema leak audit

Date: 2026-08-05

Task: `beads-call-minimization-5js` — Audit Beads schema leaks.

## Scope

This read-only audit checks the accepted model and Worker coordination surfaces for Beads-specific schema names, fields, and descriptions. It does not change production code. The checkout contained concurrent uncommitted implementation changes; those changes were not reverted.

## Result

The model `content` projection is clean for the checked result paths. It hashes raw authority versions into opaque `v_` references and omits raw semantic details from model content. Evidence: `npx vitest run src/model-tool-contract/catalog.test.ts src/model-tool-contract/result-projection.test.ts src/utils/tool-surface.test.ts` passed 3 files and 28 tests.

The audit found three boundary leaks:

1. **Candidate schema imports a Beads module.**
   `src/model-tool-contract/catalog.ts` and `src/model-tool-contract/result-projection.ts` import `CandidateTaskCurrentContextSchema` from `src/utils/beads.ts`. This couples the model contract to the current Task backend. Move the shared length/schema definition to a neutral model-contract or domain-schema module, then let the Beads adapter import it for write validation.

2. **A Beads-specific reason is in the model-facing result schema.**
   `beads_external_writer_atomicity_unavailable` appears in the `task_update` contract-gap variants in `src/model-tool-contract/catalog.ts` and `src/model-tool-contract/result-projection.ts`. The generic surface should expose a backend-neutral reason such as `external_writer_atomicity_unavailable`; the Beads adapter should map its internal failure to that reason. The generated review at `docs/generated/model-tool-contract-review.html` repeats the current Beads-specific literal and needs regeneration after the contract change.

3. **The Worker public parameter description names native Beads notes.**
   `extensions/index.ts` describes `append_note` as `Append prose to the Task's native Beads notes`. Worker tools are model-facing, so this exposes the persistence implementation. Use semantic wording such as `Replace the current Task context and record progress evidence` while retaining the adapter's internal Beads-note mapping. The implementation already treats this input as candidate current context and rejects over-limit values.

## Checked and not classified as leaks

- Raw semantic `details` intentionally retain full authority records for machine truth and QA. `assembleCandidateToolResult` serializes only the validated model projection into `content`; this is an intentional raw-details boundary, not a model-content leak.
- `taskVersionRef()` maps raw authority versions to opaque `v_` references. The projection tests cover this boundary.
- `CandidateBeadsTaskAdapter`, `CandidateTaskAuthorityRecord`, Beads command errors, and Beads metadata remain in the internal adapter/authority seam. They are not exported by the model tool catalog and should remain behind that seam.
- `TeamConfig.taskBackend`, Beads authority fingerprints, and Beads diagnostics belong to internal persistence/status surfaces. They must not enter the model Team-create parameters or candidate result projection. The candidate catalog rejects extra backend fields; the catalog test covers this.
- Terminal target `backend` is a separate terminal-adapter coordinate. It is not a Beads leak.

## Files changed

- Added this journal handoff: `docs/journal/2026-08-05-beads-schema-leak-audit.md`.
- No production files were changed.
- No concurrent Worker files were reverted or edited.

## Tests

- Passed: `npx vitest run src/model-tool-contract/catalog.test.ts src/model-tool-contract/result-projection.test.ts src/utils/tool-surface.test.ts` — 3 files, 28 tests.
- Failed: `npm run typecheck`, due to unrelated shared-tree fixture errors at `src/utils/clean-cut-round2.test.ts:257` and `src/utils/task-delivery.test.ts:127`.

## Risks

- The three identified leaks remain unfixed because this was a read-only audit.
- The generated review contains the Beads-specific reason and will remain stale until the public reason is renamed and the artifact is regenerated.
- Task authority state is unmodified; no Task claim, status, evidence, or Alert was accepted from this Session.

## Next action

The lead should verify this handoff, reconcile the Team to one implementation version, then assign implementation work to move the shared schema and rename the public reason. Regenerate the contract review and add provider-schema assertions for the Worker description. After the fresh Team starts, the lead should resolve this audit Task from the handoff evidence.

## Verification limits

`npm run typecheck` was attempted but the shared tree currently fails in unrelated existing test fixtures:

- `src/utils/clean-cut-round2.test.ts:257` — possibly undefined `ownershipLost.taskSnapshot`.
- `src/utils/task-delivery.test.ts:127` — possibly undefined value.

Task authority operations were unavailable for this Worker because Team `beads-call-minimization` is pinned to implementation `0.17.0-rc.4`, while this Session runs `0.17.0-rc.5`. The authority refused `task_read` and `alert_send`, so this report cannot claim or close the Task. Reconcile the Team epoch before the next Task mutation.
