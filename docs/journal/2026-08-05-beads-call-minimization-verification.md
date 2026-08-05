# Beads call-minimization verification

Date: 2026-08-05
Task: `beads-call-minimization-m5v` — Reduce mutation preflight calls

## Current state

The shared checkout contains concurrent Worker changes. This Worker cannot read
or mutate the Team Task authority because the Team still reports implementation
`0.17.0-rc.4` while this Session runs `0.17.0-rc.5`; `task_read` returns the
mixed-version error. The lead received the attention Alert. Do not claim or
close the Task until the Team epoch is reconciled.

## Implementation evidence

The implementation keeps the safe reductions described in the implementation
handoff:

- A committed create reuses the exact post-create candidate authority record.
  Replay still performs a detailed read because compact idempotency records do
  not carry relation identities.
- Multi-Task model updates use one exact-ID candidate hydration and reuse each
  raw record. The Beads mutation still reads the raw Task under its lock and
  checks the expected raw version before update, so the batch is not a CAS
  proof.
- `task_link` skips the outer source read only when no opaque expected version
  needs resolution. The lower mutation still reads source and target under its
  lock and performs the final source read.
- Model lifecycle guards use compact `listTaskIds`; detailed legacy receipts
  still use `listTasksWithVersions`.
- Missing-aware multi-ID hydration preserves requested order and does not invent
  records for missing IDs.

## Verification

Passed:

- `npm run typecheck`
- `git diff --check`
- `npx vitest run src/model-tool-contract` — 8 files, 66 tests
- `npx vitest run src/model-tool-contract/beads-task-adapter.test.ts src/model-tool-contract/durable-model-tool-port.test.ts src/model-tool-contract/mutation-call-minimization.test.ts` — 3 files, 34 tests
- `npx vitest run src/utils/beads.test.ts src/utils/tasks-event-publication.test.ts src/utils/task-delivery.test.ts src/utils/worker-task-update-version-ref.test.ts` — 4 files, 18 tests
- `npx vitest run --config vitest.full.config.ts src/utils/release-p1-contract.test.ts` — 15 tests
- `npx vitest run --config vitest.full.config.ts src/utils/launch-compensation.contract.test.ts` — 13 tests
- `npx vitest run --config vitest.full.config.ts src/utils/topology-lifecycle.contract.test.ts` — 3 tests
- `npx vitest run --config vitest.full.config.ts src/utils/ergonomic-tool-contract.test.ts` — 16 tests
- `npx vitest run --config vitest.full.config.ts src/utils/binding-correctness.test.ts` — 10 tests

Lifecycle contract fixtures now mock the compact `listTaskIds` seam. The
existing broad clean-cut lane still has an unrelated concurrent delivery
projection failure, so no broad-suite pass is claimed here.
