# Real-Pi atomic Task-update canary

Date: 2026-08-02
Status: passed

A blind `openai-codex/gpt-5.6-luna` model completed this candidate journey
through package-local Pi 0.80.10:

1. `team_create`
2. `ensure_worker`
3. `task_create`
4. `task_read`
5. `task_update`
6. `team_sync({view:"snapshot"})`

The exact bound leader recorded one coordination decision without claiming
Worker execution. One update atomically replaced current context, appended an
authority-identified leader journal entry, kept the Task open, and advanced its
version once. The later snapshot matched the complete updated Task card.

`task_update` accepts an ordered batch. Each item supplies Task identity, a
Task-scoped operation ID, expected version, replacement current context,
nonempty journal inputs, and optional status. Identical operation replay returns
the original receipt without duplicate evidence. Conflicting operation reuse
and stale versions refuse without mutation and return current Task state when
known. Duplicate Task IDs refuse the whole batch before mutation.

Focused evidence also proves that one operation ID can apply independently to
two Tasks. Closing an assigned Task removes it from its Worker's nonterminal
index; returning it to a nonterminal status restores the index. These state,
journal, replay, and index writes share one synchronous preliminary mutation.

The redacted machine receipt is
[`artifacts/2026-08-02-model-tool-task-update-canary.json`](artifacts/2026-08-02-model-tool-task-update-canary.json).
Private provider, RPC, and Session evidence remains outside Git.

This proves leader-side coordination updates in one process. It does not prove
Worker update authority, durable idempotency, incremental Team updates, public
registration, or production readiness.

Architecture impact: none. The candidate remains explicit and non-public.
