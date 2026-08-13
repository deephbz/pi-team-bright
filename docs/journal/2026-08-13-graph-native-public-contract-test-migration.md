# Graph-native public-contract test migration

Date: 2026-08-13
Task: `ptb-graph-native-next-6we`
Base source: `9adbadd0bf4be71cd37195e4da53eacece4f664b`
Stage: hardening
Architecture impact: none

## Result

The four stale assertions reported by independent Task
`ptb-graph-native-next-071` now encode the accepted graph-native public
contract. This change does not alter the registered tool count, Task authority,
or runtime behavior.

The catalog contract now validates singleton graph-aware `task_update` context
limits. Its review rendering shows `task_graph_apply` with complete-revision
coordinates and the singleton `task_update` fields. The clean-cut public-surface
test now inspects the registered `task_graph_apply` schema and singleton
`task_update` schema. Its executable path covers complete graph apply, an exact
singleton claim race, stale-version refusal, context update, current read and
sync, graph replacement, and derived dependency waiting.

## Verification

The exact independent verifier bundle passed:

```text
./node_modules/.bin/vitest run --config vitest.full.config.ts \
  scripts/model-tool-context-budget.test.ts \
  src/model-tool-contract/catalog.test.ts \
  src/utils/task-surface-cleancut.e2e.test.ts \
  src/task-authority/graph-control.smoke.test.ts \
  src/task-authority/graph-control.integration.smoke.test.ts \
  src/task-authority/ready-dispatch.test.ts \
  src/task-graph-view/layout.test.ts \
  src/task-graph-view/component.test.ts
```

Result: 8 files and 29 tests passed. `npm run typecheck` also passed. The broad
`test:full` aggregate did not rerun.

No push, tag, publication, or registry mutation occurred.
