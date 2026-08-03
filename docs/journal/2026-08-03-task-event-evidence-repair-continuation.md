# Task-event evidence repair continuation

Date: 2026-08-03

## Active work contract

Task `ptb-tool-result-projection-review-2t4` is assigned to `projection-implementer` and is in progress. The observed installed-package Herdr flow was snapshot, `task_update`, `task_link`, `alert_send`, then `team_sync({view:"updates"})`. It returned `structured_task_event_evidence_absent` for newly produced Task event 5. A recovery snapshot succeeded.

## Established cause and smallest owning invariant

`projectCandidateTaskChanges()` in `src/model-tool-contract/beads-task-adapter.ts` correctly refuses any Task event without `taskEvidence`. It must continue to do so for historical or malformed records.

Current ordinary publication in `src/utils/tasks.ts` calls `publishTaskMutation()`. When `taskEventEvidence` is empty, it calls `appendTeamEvent(baseEvent)`, which produces an unstructured Task event. `mutateTaskLink()` always follows that path. The candidate update adapter passes structured evidence only for candidate leader Task updates. Thus current Task mutations can create an event that the candidate update projection cannot safely reconstruct. The repair belongs in Task-event publication, not the projector.

`publishTaskMutation()` already owns committed Task-event publication. Make all newly written Task events carry typed structured evidence. Derive evidence from the committed mutation and actor, not caller prose or a renderer. Task-update evidence must retain supplied journal facts. Task-link needs a structured relation/change record. Preserve `contract_gap` for existing malformed evidence.

## Related QA defect

The product and systems observer journals identify stale QA evidence. `DurablePreviewTeamPort.readTeamSync()` keeps a pending observation until provider acknowledgement. The QA fixture invokes real tools directly but does not acknowledge that pending result, so later updates calls replay the pending snapshot. Fresh QA has no real `updates`, `contract_gap`, or cancelled cases. Fix the fixture/harness acknowledgement path rather than hiding this behavior.

The QA suite areas read so far are `scripts/tool-result-qa/suite.test.ts` around lines 470-700. It captures an initial snapshot then tries `sync-task-change`, but direct invocation does not simulate the provider acknowledgement used by `extensions/index.ts` before-provider hook.

## Additional acceptance added by lead/verifier

- Replace stale identity assertions in `scripts/probe-model-tool-vertical-slice.ts` and `scripts/model-tool-canary/run.mjs` with raw-details/model-content assertions.
- Make `projectWorkerReceipt` exhaustive and typed, fail closed without generic fallback or `any` semantic fabrication.
- Remove `src/utils/receipt-types.ts` if no independent current authority needs it.
- QA must include real updates plus explicit malformed-event `contract_gap`; retain mixed batch, operation conflict, and Worker refusal coverage where fixtures support them.

## Constraints and evidence

- Do not run tests while editing.
- After edits, run only focused event/sync tests and one installed-package Herdr-equivalent probe or deterministic external-adapter test. Do not add broad lanes.
- Keep version/package metadata at `0.17.0-rc.2`.
- Commit this repair separately.
- Preserve current observer journals. Two observer handoff files were untracked and concurrent when this task started; do not delete or overwrite them.

## Current source pointers

- `src/utils/tasks.ts`: `publishTaskMutation()` and `mutateTaskLink()`.
- `src/utils/team-events.ts`: `appendTaskEvidenceEvent()` and `projectTaskEventEvidence()`.
- `src/model-tool-contract/beads-task-adapter.ts`: strict Task-event projection and gap result.
- `src/model-tool-contract/durable-preview-port.ts`: `projectUpdates()` and pending observation staging.
- `scripts/tool-result-qa/suite.test.ts`: direct real-tool QA fixture.

Architecture impact is expected to be `none`: this repairs an existing Task-event publication invariant without changing public model contracts, component responsibility, or topology.

## Implementation and focused evidence

`publishTaskMutation()` now always appends `taskEvidence`. It derives a typed fallback from committed before/after Task state when the caller has no journal evidence. `mutateTaskLink()` supplies an exact relation record. Assignment mutations now publish the Team event before their owner-transition delivery shell runs, without duplicate recipient delivery.

The QA fixture now invokes the extension's `tool_call` and `before_provider_request` hooks around each direct tool call. It records each result as a branch tool-result entry, so its normal acknowledgement path advances the hidden observation. It contains a real updates assertion, an explicit unstructured legacy Task-event gap, and snapshot recovery. It cancels its empty-wait fixture instead of waiting for the production 120-second interval.

Focused evidence: `npx vitest run src/utils/tasks-event-publication.test.ts` passed in 280 ms. It uses the Task authority shell with mocked Beads mutations and the real Team-event journal. It proves current status updates and `task_link` append typed evidence. `npm run probe:model-tools` passed earlier in this task and exercised the registered model-tool adapter. No broad suite was run after the team-wide focused-test rule.

Architecture impact remains `none`.
