# Real-Pi snapshot and updates canary

Date: 2026-08-02
Status: passed

A blind `openai-codex/gpt-5.6-luna` model completed this candidate journey
through package-local Pi 0.80.10:

1. create Team, Worker, and assigned Task;
2. call `team_sync({view:"snapshot"})`;
3. read and atomically update the Task; and
4. call `team_sync({view:"updates"})`.

The snapshot established a pending hidden observation. The extension committed
its baseline only after `before_provider_request` verified the exact persisted
tool result on the current Session branch and in provider input. The later
updates call returned only the Task progress delta, including committed leader
journal evidence and latest Task state.

The preliminary observation coordinate includes exact Session branch ancestry,
Team epoch, tool-call identity, result digest, and authority head. An
unacknowledged result replays but cannot skip changes. A branch before the
acknowledged result has no baseline. Model compaction has no hook and changes no
Task or observation state.

Focused evidence covers `snapshot_required`, immediate changes, caught-up wait,
wake/rescan, named cancellation, Worker wake, status change grouping, pending
replay, branch lineage, and Team epoch. Cancellation and authority failure
publish no observation and advance nothing.

The redacted machine receipt is
[`artifacts/2026-08-02-model-tool-snapshot-updates-canary.json`](artifacts/2026-08-02-model-tool-snapshot-updates-canary.json).
Private provider, RPC, Session, and branch evidence remains outside Git.

This proves one-process snapshot and incremental-update composition. It does
not prove durable cross-process authority, real Worker execution, public
registration, or production readiness.

Architecture impact: none. The candidate remains explicit and non-public.
