# 0016 — Framework-owned Team synchronization delivery

Date: 2026-09-26
Status: accepted intent; implemented and verified in an unpublished candidate

## Decision

Coordination owns one complete Team observation and its exact leader-branch
baseline. The Pi adapter owns scheduling and presentation. The model can request
`team_sync`, but continued delivery does not depend on a final model call.

A settled leader receives new observations in batches. A maximum delay and a
semantic update-count threshold schedule delivery. Empty probes do not start a
turn. `/teamsync` performs one immediate observation and reports an empty result
only in the TUI. All routes use the same projection and acknowledgement boundary.

Pi lifecycle events supply Worker activity. Settled Workers can have unfinished
Tasks. A native wait repeats its internal interval while fresh current activity
supports waiting. Pending delivery alone receives one bounded interval. Missing
runtime evidence returns `indeterminate`; process absence cannot imply success.

## Pi boundary

Pi 0.87.1 provides no extension method to append a native tool-call/result pair.
The adapter executes synchronization itself and preserves an explicit
framework-origin record through public extension APIs. Context projection gives
the provider the matching tool call and exact executed tool result. It gives
these projected entries zero usage and does not claim that the model authored
them. No private Session writer or provider-generated instruction is required.

An observation advances only after exact persisted presentation evidence and a
successful provider turn containing the result. Probe, queue, display, provider
request, and acknowledgement remain distinct states. Branch or Membership
changes invalidate an in-flight candidate. Failure leaves the unseen observation
recoverable without an unbounded model retry loop.

## Reversal

Replace the projection adapter if Pi adds a public framework tool-execution API
with equivalent persistence, ordering, and cancellation guarantees. Revisit
batch defaults using operator evidence. Do not infer Task completion or fabricate
Worker activity to make a wait terminate.

The [work record](../projects/team-sync-continuity.md) owns the five-round
verification evidence. Executable contracts own the final scheduling and
presentation mechanics.
