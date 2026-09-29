# Compaction delivery gate

Date: 2026-09-29
Status: implemented and verified locally

## Incident

The owner reported Pi Team Bright messages arriving while a Pi agent compacted.
The report covered team_sync, Alerts, and other Pi Team Bright model messages.

## Cause

Pi's `sendCustomMessage` does not check `isCompacting` in 0.83.0 or 0.87.1.

- Manual compaction first aborts the agent run. A `triggerTurn` send during
  the summary request therefore starts a new agent run beside compaction.
- Automatic compaction runs inside an agent run. A send then queues a steer
  beside the summary request.

Task and Alert delivery sent on each poll or file watch without any Session
state check. Framework team_sync and doctor checked `ctx.isIdle()`. Only Pi
0.87.1 includes compaction in that check.

## Change

`extensions/compaction-delivery-gate.ts` owns one invariant: no Pi Team Bright
model message reaches Pi while the Session compacts. The Session adapter routes
Task, Alert, team_sync, and doctor sends through the gate sink.

- `session_before_compact` closes the gate.
- `session_compact` and `session_compact_failed` open it. Pi emits both events
  before it clears its compaction state, so held sends flush one macrotask
  later, in order.
- Pi 0.83.0 has no `session_compact_failed`. A 15-minute hold limit opens the
  gate when compaction fails or another extension cancels it.
- `session_start` and `session_shutdown` drop held sends. Task and Alert
  delivery re-present from durable records on activation.
- team_sync and the sync conductor treat a closed gate as busy. The gate
  notifies the conductor when it opens.
- Session entries (`appendEntry`) pass through; acknowledgements never wait.

## Evidence

`scripts/compaction-delivery-e2e/run.mjs` runs a real Pi RPC leader with a real
Team and one real Worker against a loopback provider. The provider holds the
compaction summary request. During the hold, the Worker claims its Task and
sends an Alert to the lead, and the operator runs `/ptb doctor`.

| Checkout | Pi | Leader requests during compaction | After compaction |
| --- | --- | --- | --- |
| Unfixed adapter (`0eea124`) | 0.83.0 | 1 | not checked |
| Unfixed adapter (`0eea124`) | 0.87.1 | 1 (plus 1 `agent_start`) | not checked |
| Gate | 0.83.0 | 0 | Alert, doctor, and team_sync reached the model |
| Gate | 0.87.1 | 0 | Alert, doctor, and team_sync reached the model |

The unfixed 0.87.1 run showed a `pi-team-bright.direct-message` turn during
compaction. The gated run also placed the Alert's Session entry after the
compaction entry.

Focused tests: `extensions/compaction-delivery-gate.test.ts` (9) and
`extensions/compaction-delivery-adapter.test.ts` (4). The adapter test fails 2
of 4 against the unfixed adapter.

## Limits

The end-to-end check covers manual compaction. Automatic threshold and overflow
compaction use the same Pi events and the same gate; no real-provider run
exercised them. On Pi 0.83.0, a failed or cancelled compaction holds messages
until the hold limit expires.

Architecture impact: none. The change stays inside the Pi Session adapter.
