# Real-Pi model-tool canary

Date: 2026-08-02
Status: passed

A blind `openai-codex/gpt-5.6-luna` model completed the accepted candidate
journey through package-local Pi 0.80.10:

1. `team_create`
2. `ensure_worker`
3. `team_sync({view:"snapshot"})`

The run used a fresh exact Session, an explicit non-public extension, no
discovered extensions or context, no built-in tools, and only the three
candidate tools. The provider-visible requests contained the exact candidate
schemas. The model preserved the logical Team and Worker, reported
`carrier:"absent"`, observed no Tasks, and identified Task creation or
assignment as the missing next capability.

The first receipt incorrectly accepted any completed assistant message as a
provider-response anchor. The corrected runner now requires either a successful
HTTP observation or a completed usage-bearing assistant response correlated
with the valid ordered tool-call and result chain. OpenAI Codex used the second
evidence class. The corrected run passed every machine check.

The redacted machine receipt is
[`artifacts/2026-08-02-model-tool-real-pi-canary.json`](artifacts/2026-08-02-model-tool-real-pi-canary.json).
Private provider payloads, RPC records, Session records, identifiers, and model
text remain outside Git in a mode-0700 bundle with mode-0600 files.

This canary proves only one provider-bound, one-process, one-Session logical
Team and Worker journey. It does not prove carrier readiness, Tasks,
persistence, updates, public registration, or production readiness.

Architecture impact: none. The harness is explicit and non-public.
