# Tool-result projection final observation handoff

Date: 2026-08-03
Status: product verification in progress; no implementation by product observer

## Current authority state

Product Task: `ptb-tool-result-projection-review-ayg`.

The implementation, cleanup, and cleanup-integration blockers are reported closed.
The clean baseline is commit `599a17e7c2c7176b53dc4865cb3825a4568eb18e`.
The fresh QA artifact is `artifacts/tool-result-qa/latest.json` with schema
`pi-teams-tool-result-qa/2`, projection version `2`, timestamp
`2026-08-03T00:33:06.613Z`, and 39 cases.

The implementation gate receipt reported `npm run typecheck` passed and the
focused projection/catalog/registration lane passed 27 tests. The product
observer did not run the release lane.

## Confirmed repaired findings

The fresh QA artifact confirms these prior defects are repaired:

- Mixed Task-create delivery degradation renders warning/partial and preserves
  the delivery warning.
- Partial Alert delivery renders warning/partial and names failed recipients.
- Partial Team shutdown renders warning/partial, names stopped and failed
  Workers, lists unfinished Tasks, and gives retry guidance.
- Task-update version conflicts preserve the current Task and exact recovery
  version.
- Task-link version conflicts now give `read_before_retry` guidance.
- Alert targets use the discriminated Worker-or-Team convention.
- The current Worker name is `ensure_worker`.
- TUI output has no raw model JSON, recursive object dump, legacy warning, or
  fabricated `unknown`/`unassigned` summary in the fresh artifact.

## Remaining product concern

The fresh artifact has no `team_sync` result with model kind `updates` or
`contract_gap`. Cases named `sync-timeout`, `sync-task-change`,
`sync-event-overflow`, `sync-multiple-changes`, and `sync-invalid-cursor` all
contain `snapshot` results, even though their calls request `view: "updates"`.
Therefore the artifact does not prove the repaired update-detail or sync-gap
projection. It may be stale scenario setup or a runtime registration/fixture
problem, but it needs explicit resolution before final product acceptance.

Source evidence already observed shows the repaired code has typed sync change
schemas and TUI detail rendering, so this is currently an evidence/coverage
finding rather than a confirmed semantic defect. Do not infer success from the
source alone.

## Other observed outcomes

Singleton Task create/read/update projections are flat and decision-relevant.
Task-update conflicts include `current_task` and `reconcile_and_retry`; the
current TUI says to read and retry at the returned version. Operation-conflict
recovery now includes a new-operation coordinate in the repaired source.
Task-link refusal says to read before retrying without fabricating a version.

Team creation, Worker ensure, Task reads, Worker stop guards, Alert refusal and
success, relation no-op, and final Team shutdown have concise semantic TUI
lines. The old pre-cutover QA artifact must not be used as current evidence.

## Next action

Inspect or obtain a fresh QA case that exercises actual `team_sync` updates and
all typed non-observation outcomes, then decide whether the missing cases are a
fixture/registration defect or only stale historical scenarios. Preserve the
remaining dissent. Close the product Task only if no operator-facing release
blocker remains. Return only: strongest claim, evidence class, remaining
pushback, owner question, next test, transferable learning note.
