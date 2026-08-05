# RC.6 exact Task boundary repair — R2 handoff

Date: 2026-08-05
Task: `rc6-boundary-repair-r2-72b`

## Verified result

The preserved RC.6 tree now keeps raw Beads authority records, metadata,
revisions, and mutation details inside the Beads adapters. The semantic Task
facade and delivery records use canonical `TaskCard` meaning and opaque
`TaskVersionRef` coordinates. `task_link` resolves a supplied public version
once to raw CAS; no-version link has no outer read. Delivery, outbox, and
reconciliation reads use adapter seams. Task mutation delivery reuses the
committed post-state without added `bd` calls. Generic Task contract events
use `goal`, and the obsolete `team-sync-actions` module and tests are deleted.

Independent focused verification found one remaining gap: an early
`projectTaskForAgent` clone path could carry a raw delivery revision when goal
and context were present. The repair validates the Task version before every
return path and fails closed with `upgrade_required` for raw revisions. Focused
regression proof covers both the supplied publication card and input-card
paths.

## Evidence and tree identity

The accepted focused checks were:

- `npm run typecheck` — passed.
- `npx vitest run src/model-tool-contract/canonical-task-cutover.acceptance.test.ts src/model-tool-contract/mutation-call-minimization.test.ts src/model-tool-contract/durable-model-tool-port.test.ts src/model-tool-contract/result-projection.test.ts src/utils/worker-task-update-version-ref.test.ts src/utils/owner-transition-outbox.contract.test.ts src/utils/task-delivery.test.ts src/utils/task-migration.test.ts src/utils/team-status.test.ts src/utils/team-events.test.ts --pool=forks` — 9 files, 74 tests passed.
- `npx vitest run src/model-tool-contract/canonical-task-cutover.acceptance.test.ts src/utils/task-delivery.test.ts --pool=forks` — 2 files, 19 tests passed after the fail-closed repair.
- `git diff --check` — passed.

Task evidence recorded the preserved tree as HEAD
`27a532d1c9c9696afe3790c081028aae8af77d76`, index tree
`bd8e83dc6d50810dd8a75c436777dfb8f2ea4741`, and working-tree manifest
SHA-256 `47da77d1a0b5094733517dddb77f478458f0e4d03edcc0527f8e3e1f993e14a9`.

Architecture impact is **none** under the canonical DSL rule. The repair
changes an internal delivery invariant only; it changes no depicted component,
dependency, trust boundary, data flow, deployment topology, or system
responsibility. The canonical Structurizr DSL remains unchanged.

## Next boundary

The next boundary is lead-owned release preparation and its required final
aggregate verification on the exact stable tree. This handoff does not
authorize aggregate tests, VCS actions, package actions, release actions,
version changes, commits, tags, pushes, or publication.

Handoff path: `docs/journal/2026-08-05-rc6-exact-boundary-repair-r2-handoff.md`.
