# Real-Pi assigned-Task canary

Date: 2026-08-02
Status: passed

A blind `openai-codex/gpt-5.6-luna` model completed the candidate journey
through package-local Pi 0.80.10:

1. `team_create`
2. `ensure_worker`
3. `task_create`
4. `team_sync({view:"snapshot"})`

The model created one assigned open Task in a batch call. The creation receipt
and later snapshot agreed on Task identity, title, goal, assignee, status,
current context, and version. The assigned Worker listed the same Task ID in
`nonterminal_task_ids`. The Worker carrier remained `absent`, so the run made no
readiness or execution claim.

The provider-visible `task_create` schema contains only an ordered `tasks`
array. Each item has `title`, `goal`, and optional `assignee`. It contains no
Team locator, backend, paging, relation, read, update, or delivery control.
Each item returns one correlated outcome; the batch itself is not atomic.

The redacted machine receipt is
[`artifacts/2026-08-02-model-tool-assigned-task-canary.json`](artifacts/2026-08-02-model-tool-assigned-task-canary.json).
Private provider, RPC, and Session evidence remains outside Git.

This proves the first Task-first model journey against a preliminary in-memory
authority. It does not prove Task execution, durable storage, incremental
updates, public registration, or production readiness.

Architecture impact: none. The candidate remains explicit and non-public.
