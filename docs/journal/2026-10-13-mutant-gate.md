# v3.1 mutant gate

Status: completed experiment; the simulator gate does **not** pass.
Scope: M1–M6 from the [verification proposal](2026-10-12-deterministic-simulation-verification.md#mutant-gate).
Architecture impact: none. Production source is unchanged.

## Result

| Mutant | Named assertion | Result | Trace id | Steps |
| --- | --- | --- | --- | --- |
| M1: shell `isAlive` authorizes reuse | P4 | Killed | `m1-gate-witness` | 5 |
| M2: live shell blocks retry after decisive refusal | retry after decisive no-start | Killed | `m2-gate-witness` | 5 |
| M3: launch holds the Membership lease | E3 | Survived | `m3-gate-witness` | 4 |
| M4: snapshot hydrates before its watermark | P8 | Survived | `m4-gate-witness` | 7 |
| M5: receipt waits up to 300 seconds for readiness | E5 | Killed | `m5-gate-witness` | 4 |
| M6: update page stamps journal head | P8 or P9 | Survived | `m6-gate-witness` | 36 |

Each row has a trace, ReplayReceipt, verdicts, and semantic evidence under
[`sim/results/mutants/M<n>/`](../../sim/results/mutants/).
`result.json` is the per-mutant result. `minimal.trace.json` and
`minimal.receipt.json` identify its recorded replay. `evidence.json` and
`control.evidence.json` retain the independent observations.

The three killing traces are 1-minimal under single-step deletion and reduction
of one timestamp to its predecessor. All retained timestamps are zero.
Each minimized mutant replay completed. Its named assertion failed. The same
trace passed that assertion on unchanged production. The three survivor traces
are targeted witnesses; they are not claimed to be minimal counterexamples.

## Reproduce

```sh
node sim/mutants/run.mjs          # all six mutants
node sim/mutants/run.mjs M2 M6    # selected mutants
```

The runner archives committed HEAD into an ignored scratch directory. It runs
an unchanged control, applies one patch, typechecks, and runs the campaign.
It reverses the patch in `finally` and verifies each affected file's digest.
It then checks the retained trace against unchanged production. The runner
removes the scratch directory. It never applies a patch to the checkout.
Its exit status reports experiment execution; read `result.json` for gate status.

The input production revision is `1a8a3f663ab04622ee909823ae349da0f94ce245`.
The initial merge of `v31-integration` contained `v31-liveness`.
The campaign dependency was then merged from `v31-sim` at `dabdd2a`.
The recorded runs use gate source `d25d22f022598a997078b416e1917c0ae8644668`
and runner `sim-c1/5`. Each result records its patch SHA-256.

## Campaign and verification

Each mutant and its control ran 37 schedules:

- Five targeted schedules, including a 60-event update backlog.
- All ten synthetic fixtures.
- All ten v3.1 generated schedule families.
- Twelve fast-check samples, with generator seed `20261013` and recorded
  per-run seeds.

This gives 444 campaign executions, plus shrinking and replay checks.
Bounds were 10000 scheduler operations and 400000 virtual milliseconds per run.
All 21 existing P/E/S monitors ran unchanged. M2 adds a focused history check
for a retry receipt after a durable decisive refusal. This campaign does not
repeat the dependency's 1000-run or 20-by-50 scale campaign.

| Mutant | Completed control schedules | Completed mutant schedules |
| --- | --- | --- |
| M1 | 32/37 | 32/37 |
| M2 | 32/37 | 32/37 |
| M3 | 32/37 | 17/37 |
| M4 | 32/37 | 32/37 |
| M5 | 32/37 | 31/37 |
| M6 | 32/37 | 32/37 |

Stopped prefixes remain explicit in `control.json` and `campaign.json`.
They do not count as kills or passes. Baseline gaps include replay bounds,
missing processes, unsupported Beads `show`, dead lead callbacks, and
cross-Session forks. M3 prevents Worker admission in many schedules. M5 also
exhausts one entropy tape.

All six retained mutant histories and verdicts matched receipt-driven replay.
All six patched scratch trees passed TypeScript checking. The unmodified gate
source also passed `npm run typecheck`. The focused fault, extraction, and
production-shape checks passed 22 tests. The six experiments took 314.696 seconds
in total, including controls, compilation, shrinking, and diagnostics.
`git diff 1a8a3f6 -- src extensions native` was empty after execution.

## Findings

### M1: P4 detects reuse of a dead Worker

The trace creates a Worker, kills its Pi process, and calls `ensure_worker`.
Its shell remains live. The mutant returns `reused`; P4 fails at history
sequence 226. The control recovers the Worker and passes P4.

This proves the monitor detects the dead-process case. The current P4 monitor
compares world liveness at the call. It does not establish the proposal's full
fresh-exact-evidence/action-origin requirement.

### M2: decisive refusal permits retry despite a live shell

The trace injects `invalid_params` before Herdr starts Pi. The real adapter
records `launch.state: refused`. The mutant returns `unbound_live` on retry;
the control starts another launch. The retry assertion fails at sequence 160.

The existing simulator's `herdr.start: refused` fault emits `start_refused`.
Production correctly treats that unrecognized code as `unknown`. It cannot
exercise M2's decisive-refusal precondition. This change adds an explicit
synthetic `invalid_params` mode to the trace format, validator, and fake wire.
The real adapter already classifies that code as decisive. No passing real
Herdr probe is claimed for this new fault. M2's result is conditional on that
synthetic wire behavior. The retained minimal trace leaves the refusal active;
the control must attempt a retry even when a later start can also refuse.

### M3: the receipt deadline contains the lease deadlock

The mutant holds the Membership lease around `launch`. The nested target-record
lease cannot proceed. At 10000 virtual milliseconds, the receipt reports
`receipt_deadline`. The launch becomes `unknown` at 10015 milliseconds. No Worker
Pi process starts. The healthy witness remains observable through 70000
milliseconds, and E3 passes.

E3 permits completion **or unknown**. The unchanged receipt deadline satisfies
that assertion despite the launch-under-lease defect. This is a gate-contract
finding: the named assertion cannot reject this mutant under the current
bounded-unknown policy. Removing the deadline would introduce another mutation.
This experiment does not do that.

### M4: snapshot ordering survives P8

P8 passes the mutant and control. The retained witness has identical evidence
for both. It does not overlap a Task write with snapshot hydration.
The campaign therefore supplies no killing schedule for this race.

P8 also lacks an independent snapshot-content check. In
`p8CoverageLedger`, an event with `seq > from` is skipped; an earlier stamp can
then count as coverage without checking represented content. A changed read
order alone cannot falsify that check in these schedules.

An existing production-service unit assertion, `captures the snapshot watermark
before Task hydration`, passes on the control and fails on M4. The two
`*.diagnostic.json` files record that result. This proves the patch changes the
intended behavior. It does not replace a simulator P8 kill or a WorldTrace.

### M5: E5 detects the readiness wait

The trace hangs Pi startup. The mutant returns its receipt after 300000 virtual
milliseconds; E5 fails at sequence 9289 against its 10000-millisecond bound.
The control returns immediately. The patch restores a readiness wait and widens
the outer deadline so that the existing ten-second guard cannot hide that wait.

### M6: P8 trusts a stamp that skips ten events

The witness creates a snapshot at cursor 2 and then adds 60 journal events.
The control delivers `(2,52]` and `(52,62]`. The mutant delivers the same first
50 changes but stamps `(2,62]`. Its next result says `caught_up` at 62.
The ten changes for `extra-25` through `extra-29` never reach the branch.

Both P8 and P9 pass. P8 trusts the earlier stamp rather than its content.
P9 checks overlapping pages; this defect skips content without duplicating a
page. The evidence files record journal cursors, delivered Worker names, and
branch stamps. This is a demonstrated false negative in P8.

The existing unit assertion `commits only native persistence and stamps the
page boundary, never the journal head` passes on the control and fails on M6.
That separate diagnostic does not change the simulator verdict.

## Remaining boundary

The patches and findings complete this Task's experiment. They do not validate
the harness. M4 needs a hydration-race schedule and independent snapshot-content
coverage. M6 needs a content-based coverage ledger. M3 needs an explicit decision
about which assertion must reject a lease deadlock when a bounded unknown
receipt remains valid. No monitor or production fix is included here.
