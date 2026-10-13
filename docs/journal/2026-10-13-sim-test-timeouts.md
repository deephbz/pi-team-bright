# Simulator test timeout calibration

Status: complete. Architecture impact: none.
Base: `fc341b23223883b988c2dd4057ce60b96123f084`.
Test change: `fa06916e0f1bd4a62b8e895a356f177f902025a2`.
No production, scheduler, concurrency, test-lane, or workload changes.

## Measurement

Three full `npm test` runs used the JSON reporter to collect per-test durations.
All three passed 2029 tests with 3 skipped. `native/bin` was absent before and
after each run. No worker limit or file filter was supplied. The survey covers
all 132 default-lane simulator cases.

The supplied lead log records the fast-check scheduler test at 5036 ms and a
5000 ms timeout. Its three local measurements were 2753, 1988, and 2177 ms.
The scheduler uses microtask checkpoints. These wall-time limits provide CPU
contention headroom; they do not change simulated time or temporal assertions.

Selection rule: consider each case whose measured worst duration reaches half
the 5000 ms default, plus any reported timeout incident. New limits use three
times the observed worst duration, rounded up to a 5000 ms boundary. The known
5036 ms failure supplies the scheduler test's lower bound. Existing explicit
limits remain when they exceed twice the measured worst duration.

## New explicit limits

| File / case | Worst observed | Timeout |
| --- | ---: | ---: |
| `core.test.ts`: fast-check single queue | 5036 ms, including supplied incident | 20000 ms |
| `campaign-faults.test.ts`: reused PID | 4562 ms | 15000 ms |
| `hydration-race.test.ts`: snapshot hydration | 4002 ms | 15000 ms |
| `attribution.test.ts`: process classification | 3982 ms | 15000 ms |
| `setup.test.ts`: Team bootstrap | 3696 ms | 15000 ms |
| `pid-reuse.test.ts`: stale Worker handles | 3519 ms | 15000 ms |
| `setup.test.ts`: Task update page | 2947 ms | 10000 ms |

Each declaration has a one-line CPU contention comment. Existing limits retain
headroom and now have the same reason comments:

- `migration.v31.test.ts`: two 60000 ms limits; worst 24273 and 11579 ms.
- `history.test.ts`: 30000 ms limits; fixture cases reached 2657 and 2466 ms,
  and automatic publication reached 8105 ms. Both fixtures share one declaration.
- `baseline.test.ts`: two 30000 ms limits; worst 2584 and 5240 ms.
- `recovery.v31.test.ts`: 30000 ms; worst 4524 ms.

Other default-lane simulator cases stayed below the selection threshold.
The full measurements remain in
[`sim/results/test-timeouts/measurements.json`](../../sim/results/test-timeouts/measurements.json).
This bounded sample does not guarantee a pass under arbitrary host starvation.

## Final gate

Three consecutive plain `npm test` runs passed after the timeout edits:

| Run | Tests passed / skipped | Files passed / skipped | Vitest duration |
| --- | --- | --- | ---: |
| 1 | 2029 / 3 | 176 / 2 | 84.97 s |
| 2 | 2029 / 3 | 176 / 2 | 88.41 s |
| 3 | 2029 / 3 | 176 / 2 | 87.22 s |

Each command included typecheck. Each returned exit zero. `native/bin` remained
absent before and after every run. The final commands had no reporter override,
worker limit, or file filter. No failed gate run was omitted.

An AST comparison against the base found 32 unchanged test callback bodies in
the ten edited files. Seeds, `numRuns`, workloads, and assertions are unchanged.
The diff contains seven timeout arguments and fourteen reason comments.
The staged privacy gate passed. No push, publication, or release occurred.
