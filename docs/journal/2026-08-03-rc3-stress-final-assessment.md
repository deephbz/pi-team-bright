# rc.3 ten-Worker stress final assessment

Date assessed: 2026-08-03
Source record date: 2026-07-15
Runtime: `0.17.0-rc.3`
Status: completed with clean Team shutdown

## Evidence boundary

The operator supplied the completed stress findings after the earlier immutable
active-prefix analysis. The external source record has SHA-256
`f1c38593e06f1090956e62e6ee12649e16532f64f116e2c20f1d2902a95c8e22`.
Raw Team records remain private. The earlier sanitized counts and source digests
remain in
[`2026-08-03-stress-team-rc3-prefix-analysis.json`](artifacts/2026-08-03-stress-team-rc3-prefix-analysis.json).

The run used ten Workers and 160 Tasks. It created 159 `blocked_by` relations
as one chain, exercised stale-write and graph probes, sent Alerts, attempted both
sync views, closed all Tasks with evidence, stopped all Workers, and shut down
with no unfinished Task IDs.

## Controls that held

- All 160 Task creates returned a Task after reconciliation.
- Single and 20-Task reads worked.
- All 159 chain relations applied. Duplicate, self, cycle, missing-target, and
  stale-version probes produced the expected graph or version outcomes.
- Workers consumed the dependency chain and closed all 160 Tasks with evidence.
- Alert delivery succeeded under load before the leader model began emitting
  invalid empty arguments.
- Team shutdown stopped all ten Workers and reported no unfinished Tasks.

The leader's later empty Alert arguments were a model or harness emission
failure. They did not show an Alert authority defect.

## Easy changes accepted for rc.4

The operating Skill and Worker schema already gained strict timeout recovery,
atomic-claim composition, receipt-version use, and new-Team creation order in
commit `d90a023`. The final record adds one safe clarification: a closed Task is
not immutable. Later evidence or relation writes can advance its version, so a
caller must use the latest receipt or read before another conditional mutation.
The Worker and leader relation descriptions carry the same rule.

No timeout value, backend lock, retry loop, or authority behavior changed.

## Deferred design work

The following changes are not easy patches:

1. Persist immutable create-operation identity. Exact replay must not compare an
   original create request with mutable current Task state.
2. Persist publication state or an outbox. Replay must complete a missing Task
   event or delivery exactly once.
3. Bound or page snapshot hydration. One full long-form Beads read must not make
   both snapshot and updates permanently unavailable at this Task count.
4. Distinguish authority timeout from graph conflict and missing structured
   event evidence in public result reasons and recovery actions.
5. Measure Beads/Dolt process, batching, queue, and timeout behavior before any
   capacity claim or concurrency change.

The design and focused acceptance cases remain in
[`2026-08-03-stress-team-rc3-investigation-handoff.md`](2026-08-03-stress-team-rc3-investigation-handoff.md).

## Release assessment

The final run strengthens the evidence for graph, version, Task completion, and
shutdown behavior. It also confirms that the bulk snapshot path is unavailable
at this scale. Therefore rc.4 can publish the strict guidance and naming fixes,
but it must not claim 160-Task snapshot support or repaired create replay.

Architecture impact: **none** for the accepted Skill, schema-description, and
test changes. Deferred persistence, public-reason, and hydration work requires a
separate architecture classification before implementation.
