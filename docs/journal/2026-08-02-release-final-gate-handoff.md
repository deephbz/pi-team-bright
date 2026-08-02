# Release final-gate blocker handoff

Task: `pi-team-bright-full-release-e2e-mxa`
Branch: `preview/new-model-tool-surface`
Package: `0.17.0-rc.1`

## Current progress

The release candidate ten-tool leader surface is implemented. The prior implementation Task closed after `npm test` passed 48 files and 388 fast-lane tests. No commit, push, or publication occurred. The working tree contains the source delta and generated contract documentation.

The verifier assigned this targeted follow-up because the final gate found compatibility and packaging blockers. Do not rerun the broad gate.

## Remaining work

1. Reconcile the 52 full-gate failures with the accepted ten-tool leader surface. Use `ensure_worker` for leaders.
2. Keep legacy `worker_ensure` behavior only in explicit Worker-role fixtures. Do not restore it on the leader or register duplicate names.
3. Add `src/utils/worker-resource-extension.contract.test.ts` to `test-lanes.json` exhaustive classification.
4. Regenerate declaration inputs and fix stale generated `dist` declarations, especially `TeamConfig.implementationVersion`.
5. Run focused failing files, typecheck, and package-generation checks only.
6. Repeat only the connected-Worker behavioral slice. Confirm two distinct connected Pi Sessions, or record the exact remaining carrier defect.

## Decisions still in force

- The leader has the ten-tool surface: `team_create`, `team_sync`, `ensure_worker`, `task_create`, `task_read`, `task_update`, `worker_stop`, `team_shutdown`, `task_link`, and `alert_send`.
- Workers keep the three-tool legacy surface: `task_read`, `task_update`, and `alert_send`.
- Team implementation-version fencing, durable Task operation replay, authoritative Task rescan, terminal adapters, Worker resources, and exact Session binding remain required.
- Do not commit, push, publish, redesign, or run the broad full gate.
