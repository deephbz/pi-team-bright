# Beads/Dolt latency and synchronization follow-up

Date: 2026-08-02

This follow-up uses the same immutable Session cutoff as the main audit.
It concerns Pi Team Bright only. It does not inspect Rarebit Summary content.

## Terminology correction

The earlier “Rarebit projection” phrase meant the Pi Team Bright Team named
`rarebit-public-release-e2e`. It did not mean the Rarebit extension, Summary,
or TUI projection.

A `team_sync` continuation is an opaque Pi Team Bright paging coordinate. It
requests the next page of a large Worker/Task projection. It has no relation to
Rarebit Summary. Pi Team Bright currently tells the model to echo this value,
so that exact paging coordinate must be model-visible. Rarebit TUI details do
not need to become model-visible.

## Did leaders over-wait?

The event wait implementation did not miss any event that matched its current
filter contract. All 79 successful leader timeouts had no contract-matching
event before their returned journal head.

However, the public argument composition caused two clear five-minute
operator-level over-waits.

Both leaders supplied `task_ids` and also requested `event_types` containing
`worker`. The implementation applies `task_ids` to the full event filter and
therefore suppresses every Worker event (`src/utils/team-events.ts:240-249`).
The schema does not explain or reject this contradiction.

The two cases were:

- `rarebit-public-release-e2e` lead Session lines 2367-2368. Worker cursors 164
  and 165 already existed, but the call waited 300.834 seconds.
- `worker-resource-projection-review` lead Session lines 650-651. Worker
  cursors 66 through 71 already existed, but the call waited 301.373 seconds.

Combined avoidable leader wait was 602.207 seconds. Both calls then advanced
past the suppressed Worker events.

This is not a missed-wakeup bug. It is an unsafe argument-composition contract.
Reject `task_ids` plus `event_types: ["worker"]`, or define task filtering only
for Task and Task-linked Alert events while returning requested Worker events.

## Repeated failure clusters

Fourteen calls ended as errors.

- Six Worker `task_update` calls combined `claim: true` with `status` or
  `append_note`. Runtime rejected all six, and each Worker retried claim alone.
  This caused six extra tool calls and at least six extra model turns.
- Six `team_sync` waits were interrupted by user or Session activity. They were
  reported as errors, although interruption is normal control flow.
- Two Rarebit-Team `team_sync` calls reached the ten-second Beads timeout while
  hydrating many Task IDs.

Two leader updates returned stale-version refusals. These were correct
optimistic-concurrency results, not malformed calls.

No leader supplied another repeatedly invalid argument shape in the audited
Team calls. The Task-filter plus Worker-event combination did not fail fast;
it caused the two silent over-waits above.

## Beads/Dolt timing statistics

Exact historical `bd` subprocess timing is unavailable. The running processes
did not set `PI_TEAMS_TRACE_JSONL`, and no semantic trace file exists.

The repository already has the needed trace contract. `src/utils/trace.ts`
records `bdTotalMs`, each `bd` command duration, lock wait, semantic operation,
and outcome when the environment variable is set.

The audit can still calculate exact outer latency and a task-engine-path upper
bound. The upper bound includes local locks, delivery, projection, scheduling,
and `bd`; it is not exact `bd` time.

Across both Teams:

- Task-engine-path upper bound: 1,060.863 seconds, or 17.681 accumulated
  minutes across concurrent Sessions.
- Adjusted non-wait Pi Team Bright latency: 1,116.790 seconds.
- The task-engine path therefore accounts for at most 95.0% of observed
  non-wait tool latency.
- Source-derived lower bound: 1,238 `bd` subprocesses for 646 Pi Team Bright
  calls.
- Read commands dominate: 724 `show` plus 315 `list` calls. These 1,039 reads
  are 83.9% of the subprocess lower bound.

Upper-bound latency by operation was:

- `team_sync` work after wakeup: 314.696 seconds.
- `task_read`: 302.403 seconds.
- `task_update`: 236.234 seconds.
- `task_create`: 186.439 seconds.
- `worker_stop`: 12.824 seconds.
- `team_create`: 6.418 seconds.
- `task_link`: 1.849 seconds.

Per Team, the task-engine-path upper bound was 792.885 seconds for
`rarebit-public-release-e2e` and 267.978 seconds for
`worker-resource-projection-review`.

Routine medians were much smaller than the total:

- `task_read`: 518 ms in the Rarebit Team and 583 ms in Worker-resource.
- `task_update`: 1,402 ms and 1,704 ms.
- `task_create`: 2,601 ms and 2,433 ms.
- `team_sync` post-wakeup work: 910 ms and 956 ms.

Four Rarebit-Team reads took 10.8, 15.7, 63.0, and 64.8 seconds. Two sync
hydrations timed out near 10.4 seconds. The distribution therefore has a real
contention tail, but routine subprocess churn is also material.

## Interpretation and next test

The data supports optimization work, but it does not yet justify a backend
replacement by itself.

The adapter launches a new `bd` process for each command. Common semantic
operations need multiple serial commands:

- Idempotent create uses `list`, `create`, then `show`.
- Update and claim usually use `show`, mutation, then `show`.
- Filtered `team_sync` usually uses `list`, then batched `show`.
- Link mutation can use four commands.

A local in-process graph or SQLite adapter should remove most process and Dolt
startup cost. Linear or Jira would replace local startup with network latency,
rate limits, and external availability, so they are not obvious speed wins.

Before selecting an engine:

1. Restart a representative Team epoch with `PI_TEAMS_TRACE_JSONL` set.
2. Measure exact `bdTotalMs`, lock wait, and non-`bd` operation time.
3. Record p50, p95, p99, command mix, Task-count scaling, and contention.
4. Run the same Task contract against one simple local graph or SQLite adapter.
5. Compare correctness, recovery, version conflicts, graph relations, and
   latency. Do not compare latency alone.

First optimize `team_sync` hydration and command batching. If exact traces still
show `bd` dominating, a local adapter trial is justified.

Machine-readable statistics are in `bd-latency.json`. They are generated by
`analyze_bd_latency.py`.
