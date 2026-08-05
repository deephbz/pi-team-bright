# Batch exact Task reads handoff

Task: `beads-call-minimization-7uo` — Batch exact Task reads

Status: implementation complete; Task state could not be claimed or closed. The
Team authority is `0.17.0-rc.4`, while this Worker loads `0.17.0-rc.5`.
Every Task read and mutation refusal reported the mixed epoch.

## Changed files

- `src/utils/beads.ts`: one native multi-ID `bd show` hydrates unique requested
  IDs. The adapter maps omitted IDs to missing results using observed Beads 1.1
  behavior. It rejects returned IDs outside the requested scope.
- `src/utils/tasks.ts`: candidate batch hydration permits an aligned missing
  record.
- `src/model-tool-contract/beads-task-adapter.ts`: batch candidate projection
  preserves missing positions and validates result count.
- `src/model-tool-contract/durable-model-tool-port.ts`: model `task_read`
  deduplicates exact inputs, hydrates once, then restores input order and
  duplicates. Authority failure returns whole-call unavailable.
- `src/model-tool-contract/in-memory-team-port.ts` and `executors.ts`: model
  projection supports the existing unavailable Task-authority result.
- `extensions/index.ts`: a Worker legacy receipt retains its one candidate
  authority record in a process-local `WeakMap`, so its projection does not
  run a second `bd show`.
- `src/model-tool-contract/beads-task-adapter.test.ts`,
  `src/model-tool-contract/durable-model-tool-port.test.ts`, and
  `src/utils/worker-task-update-version-ref.test.ts`: focused command-count,
  exact-ID, duplicate, missing, unavailable, and Worker receipt coverage.

The shared tree also contains concurrent work in `src/utils/task-delivery.*`
and the snapshot/update cache sections of the durable port. This Task did not
own those changes. Do not discard them during integration.

## Native Beads evidence

A disposable Git plus Beads 1.1 workspace showed these native read results:

- `bd show <existing-1> <existing-2> --include-dependents` returns both records
  with exit 0.
- A mixed existing and absent ID returns only existing records, writes
  `Error fetching <absent>: no issue found matching ...` to stderr, and exits
  0.
- An all-absent request returns the documented no-issues JSON error and exits
  1.
- Repeated positional IDs return repeated records. The model port removes such
  duplicates before the native call and restores duplicates in its result.

## Focused verification

Passed on the merged working tree:

```text
npm run typecheck
npx vitest run src/model-tool-contract/beads-task-adapter.test.ts src/model-tool-contract/durable-model-tool-port.test.ts
# 30 tests passed
npx vitest run src/utils/worker-task-update-version-ref.test.ts
# 4 tests passed
npx vitest run src/model-tool-contract/task-semantic-totality.test.ts src/model-tool-contract/beads-task-adapter.test.ts src/model-tool-contract/durable-model-tool-port.test.ts
# 34 tests passed
npx vitest run src/model-tool-contract/first-journey.test.ts src/model-tool-contract/task-semantic-totality.test.ts
# 12 tests passed
git diff --check
```

## Risks and next action

The missing-ID recognition matches the observed native Beads 1.1 stderr and
all-missing error forms. Recheck it when the owned Beads version changes.

The lead must reconcile to a one-version Team epoch, inspect this shared-tree
handoff with the concurrent cache and delivery changes, then run the focused
checks once on the stable final tree. The lead can then close or block the
Task with this evidence.
