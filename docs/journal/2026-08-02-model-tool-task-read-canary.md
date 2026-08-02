# Real-Pi batch Task-read canary

Date: 2026-08-02
Status: passed

A blind `openai-codex/gpt-5.6-luna` model completed this candidate journey
through package-local Pi 0.80.10:

1. `team_create`
2. `ensure_worker`
3. `task_create`
4. `task_read`
5. `team_sync({view:"snapshot"})`

The batch read returned the assigned Task as one ordered `found` outcome. Its
Task card matched the creation receipt and later snapshot. The preliminary
authority revision did not change during the read.

`task_read` accepts only a nonempty `task_ids` array. Duplicate IDs produce one
deterministic outcome per input occurrence. A coherent authority read returns
ordered `found` or `missing` outcomes. Authority failure returns one top-level
`unavailable` result without partial Task cards. The call exposes no Team
locator, journal selector, paging, filter, backend, or delivery control.

The redacted machine receipt is
[`artifacts/2026-08-02-model-tool-task-read-canary.json`](artifacts/2026-08-02-model-tool-task-read-canary.json).
Private provider, RPC, and Session evidence remains outside Git.

This proves a model can batch-read current Task state without changing the
preliminary Team authority. It does not prove Task history, updates, durable
storage, public registration, or production readiness.

Architecture impact: none. The candidate remains explicit and non-public.
