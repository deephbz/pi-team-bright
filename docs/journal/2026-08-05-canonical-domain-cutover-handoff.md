# Canonical domain cutover handoff

Date: 2026-08-05
Worker: `canonical-cutover-implementer`
Task: `canonical-task-integration-e5i` — Remove remaining Task compatibility facades

## Durable progress

The Task was claimed with post-claim version `v_4c1997c49f493b8a`. The preserved shared tree has these changes from this turn:

- The model contract now imports the sole `TaskCardSchema` and `TaskCardWarningSchema` from `src/model-tool-contract/task-domain.ts`; duplicate catalog and result-projection Task-card schemas were removed.
- `CandidateTaskCardSchema` and `CanonicalTaskCardSchema` catalog exports were removed. Catalog tests now import `TaskCardSchema` from `task-domain`.
- Model ports, durable ports, executors, runtime exports, extensions, and the Beads adapter now use `TaskCard`, `TaskCardWarning`, and `TaskVersionRef` directly instead of `ModelToolTaskCurrent`, `ModelToolTaskProjectionWarning`, and `ModelToolTaskVersionRef` facades.
- Team-sync delta current state now uses a complete canonical `TaskCard`, and in-memory, durable, and adapter projections were updated accordingly.
- Task-card size validators moved to the neutral domain module. Beads no longer owns candidate context/goal schemas or candidate-named validators; adapter validation uses neutral domain limits and predicates.
- Worker `alert_send` was replaced with direct current semantic registration using `alerts.sendAlert` and `assembleCandidateToolResult`; its Task version parameter uses `TaskVersionRefSchema` and no legacy receipt/backend vocabulary.
- Worker and model-port optimistic version inputs now use `TaskVersionRef`; first-journey fixtures use opaque refs and complete-card deltas.
- Delivery refuses publication when canonical current context is absent and emits an explicit incomplete-goal warning instead of placeholder Task meaning.
- The generated model contract review was regenerated with `npm run docs:model-tools`.
- Authority record types moved out of `models.ts`; `tasks.readTask/readTasks/listTasks` and legacy `team_sync` hydration now translate through `CandidateBeadsTaskAdapter`. Team events and sync recommendations consume canonical cards or minimal semantic context.
- Focused model contract, event, sync, and delivery tests passed (77 tests). `npm run typecheck` passed after the latest edits.

## Remaining boundary note

The shared tree still contains legacy mutation-service authority state and delivery `effectiveVersion` normalization for old direct callers. These paths remain the blocker for the full strict cutover. The current delivery path fails closed instead of publishing fabricated context. Architecture impact: `changed` at the internal responsibility boundary, with no component identity or deployment-topology change; the canonical Structurizr topology remains valid.

## Verification boundary

Passed: `npm run typecheck`; focused model contract tests for catalog, result projection, Beads adapter, semantic totality, and first journey (46 tests); focused Task delivery tests (10 tests); `npm run docs:model-tools`; and `git diff --check`. No aggregate or release lane was run.
