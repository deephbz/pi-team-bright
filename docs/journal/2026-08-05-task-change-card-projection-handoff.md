# Task-change card projection handoff

Date: 2026-08-05
Task: `beads-call-minimization-5ep`
Worker: `delivery-projection-implementer`

## Scope completed

Worker-visible `pi-teams.task-change` content now uses the canonical Task card shape:
`id`, `title`, `goal` or `goal_state: incomplete`, `status`, optional `assignee`,
`current_context`, and an 18-character `v_` version reference. Delivery IDs,
raw authority refs and Beads revisions, change kinds, compatibility fields,
provenance, acknowledgements, replay data, and recovery data remain outside
model content.

New delivery and recovery records persist the canonical Task projection. Raw
`TaskFile` payloads remain accepted only for legacy pending records and legacy
outbox recovery. Legacy records are projected locally without an authority read.
Candidate create/update publication carries canonical goal/context to the
publication boundary. Owner-transition recovery carries the canonical card and
keeps the raw authority revision only as internal delivery identity evidence.

## Files changed in this scope

- `src/utils/task-delivery.ts`
- `src/utils/tasks.ts`
- `src/utils/beads.ts`
- `src/model-tool-contract/beads-task-adapter.ts`
- `src/model-tool-contract/beads-task-adapter.test.ts`
- `src/utils/task-delivery.test.ts`
- `src/utils/owner-transition-outbox.contract.test.ts`
- `src/utils/clean-cut-contract.test.ts`
- `src/utils/clean-cut-round2.test.ts`

The working tree also contains concurrent changes from other workers. Do not
reset or selectively restore the shared tree without reconciliation.

## Verification

- `npx vitest run src/utils/task-delivery.test.ts src/model-tool-contract/beads-task-adapter.test.ts --pool=forks`: 26 passed.
- `npx vitest run src/utils/owner-transition-outbox.contract.test.ts src/utils/task-delivery.test.ts --config vitest.full.config.ts --pool=forks`: 16 passed.
- `npx tsc --noEmit --pretty false`: passed after the projection changes.
- `git diff --check`: passed.
- A combined contract run timed out in `clean-cut-contract.test.ts` at `delivers accepted Task changes as steer by default without creating a Message`; isolate this test in a fresh single-version epoch.

## Risks and next action

The current Team epoch is mixed: the leader authority is rc.4 and Workers load
rc.5. `task_read` refused all Task authority mutations, so this Worker could not
claim or close the Task. The lead must reconcile the shared tree, start a fresh
single-version epoch, isolate the clean-cut timeout, run the final package lane,
and then close the Task with the final evidence.
