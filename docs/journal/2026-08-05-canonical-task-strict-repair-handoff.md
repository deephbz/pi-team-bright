# Canonical Task strict-repair handoff

Date: 2026-08-05
Task: `canonical-task-integration-88y`

Task claimed at version `v_a2d45deae9a238dd`. The repair scope is authoritative:
remove `authority_version` and raw revisions above Beads, including catalog,
result/executor, event refs, outbox/lifecycle/delivery refs, and optional
`authorityId`/`nativeId`; remove or replace `task-delivery-migration.ts` so it
never infers goal or context from compatibility fields; stopped-epoch migration
must rehydrate canonical cards through the Beads adapter with one scoped list and
one multi-ID show, then atomically rebuild or fail `upgrade_required`; replace
helper-only acceptance with real mutation-to-delivery parity and zero added bd
calls; update current tests and direct Worker schemas.

Before compaction, the preserved tree had `npm run typecheck` passing. The prior
implementation added `src/model-tool-contract/task-domain.ts`, opaque
`TaskVersionRef`, canonical delivery cards, direct Worker Task paths, and an
explicit migration module, but the independent verifier found strict-boundary
failures. The active migration module still infers goal from legacy
`description` and context from `design`; this is explicitly unsafe and must be
replaced. `src/utils/task-delivery.ts` still has optional `authorityId` and
`nativeId` compatibility fields, and model result/catalog/executor and event
paths still expose `authority_version` or raw revision values.

Do not reset the shared tree. Preserve safe call reductions and unsafe-call
removals. Continue with focused edits and checks only; no release actions.
