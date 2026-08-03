# Worker exact-extension and event-publication smoke

Date: 2026-08-03
Commit: `3f6e4d6cd5e48ff219e5430d250f0a1195d18a0b`

## Finding and repair

The first exact-source Worker launch used `-e <extension>`, but Pi also loaded the registered global package. Duplicate `alert_send`, `task_update`, and `task_read` registrations stopped Worker startup. Pi recommended `-ne`.

The repaired Worker command suppresses ambient extensions, then loads the Team extension once with `-ne -e <exact-extension>`. The focused launch contract test passed. The implementation commit is `3f6e4d6`.

## Real-Pi evidence

The ten-tool smoke ran in clean Herdr tab `w4:t49` from a detached worktree at the exact commit. Leader Session `019fc56e-0ec1-77b9-800e-6c2bef1b79bb` exercised `team_create`, `ensure_worker`, `task_create`, `task_read`, status-only `task_update` with a short version reference, `task_link`, `alert_send`, `team_sync`, `worker_stop`, and `team_shutdown`. Worker Session `019fc56e-ac38-7f47-89c9-3a6f5174d37b` loaded and received its assigned Task.

A second clean smoke isolated Worker event publication in Herdr tab `w4:t4A`. Leader Session `019fc571-068e-7e0e-961f-b968c44c4401` never mutated the assigned Task. Worker Session `019fc571-82ed-745d-80dc-a38b384641a5` changed Task `e2e-worker-publish-3f6-t7o` to `in_progress` with progress evidence, then closed it with result evidence. The leader received one typed `team_sync` Task change for each Worker mutation. No `contract_gap` occurred.

Both smoke Teams stopped their Worker and shut down with zero unfinished Tasks. No source suite ran during either smoke.
