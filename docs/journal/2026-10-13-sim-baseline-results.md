# Pre-v3.1 simulator campaign

Status: completed experiment. Architecture impact: none. No production behavior
or contract changed. This result does not establish v3.1 conformance.

## Source bundle and reproduction

- Production: `14d92fdc2c7cf0b21f6853ba495d828350901e03` (C0; no C2 or C3).
- Approved schema-only extraction: `60cdc2c`, cherry-picked from `5ccac61`.
- Simulator: `6de54d4b03553751761c35b66503eb182d4458f3`.
  Local type intersections accommodate `yield`, `argv`, and `execPath` without
  changing production types or runtime behavior.
- Independent monitors: `461aa39816e690f7c5bbb9bd5d95d00e17d1e5de`.
- Driver: `sim/baseline-campaign.test.ts`; runner `sim-c1/3`.
- Canonical machine result: `sim/results/baseline/campaign.json`.
  Earlier files outside that directory describe earlier experiments.

```sh
npm run typecheck
npx vitest run --config sim/baseline-campaign.config.ts --reporter=verbose
npx vitest run sim/baseline.test.ts sim/extract/extract.test.ts sim/core.test.ts --reporter=verbose
```

The dedicated campaign command writes the result artifacts. All persisted
inputs are synthetic. Raw histories remain transient because wire calls contain
isolated filesystem paths. Each minimized trace has a sibling ReplayReceipt.
Replay compares the complete history and all monitor verdicts before persistence.

## Coverage and runtime

The campaign evaluated all 21 monitors on ten synthetic fixtures, including both
owner scenarios, and 200 fast-check samples. All 200 generated runs completed.
Five fixtures completed; five stopped with explicit model or bound errors.
Monitors still inspected those five prefixes. Prefix verdicts do not establish
whole-trace conformance.

Fast-check seed: `20261013`. Fixed-fixture scheduler seed: `42`. Each generated
sample records its scheduler seed and delay in the machine result. The generator
selects one of five templates and adds 0–40 ms to input timestamps at or above
2 ms. Template counts: dead Pi 47, never starts 32, PID reuse 59, cursor replay
28, escape 34. This samples timing and scheduling within those classes; it does
not generate arbitrary world-step sequences.

Wall time: 91.159 s for fixtures and generated samples; 121.039 s including
shrinking and receipt replay. Vitest took 121.91 s. These are single-trial
measurements under concurrent host load.

## Observed violations

| Monitor | Minimized trace id | Steps | Finding |
| --- | --- | ---: | --- |
| P4 | `baseline-p4-minimal` | 5 | Reuse of `team-1/w1` while its Pi process was dead. |
| P5 | `baseline-p5-minimal` | 4 | Launch cleanup closed `pane-1` without a prior stop tool call. |
| E5 | `baseline-e5-minimal` | 4 | An ensure receipt took 300000 virtual ms; the bound is 10000 ms. |

Files: `sim/results/baseline/{P4,P5,E5}.trace.json` and corresponding
`.receipt.json` files. Shrinking used 31, 20, and 20 candidate executions.
Each trace is 1-minimal under single-step deletion and reduction of one timestamp
to its predecessor, restricted to runtime-valid traces that still violate the
same property. This is not a global minimum or a claim about all shrink orders.

Across all 210 histories, P4 violated 108 times; P5 violated 34 times; E5 violated
33 times. One P5 verdict came from the stopped shutdown/resume prefix. Its pane
closure had OS origin. The other 33 P5 verdicts came from completed never-starts
runs. P5 reports the current monitor contract; this experiment does not decide
whether compensated launch cleanup should be allowed by that contract.

The original owner scenario 2 also violated P4. Its final pane retained a live
shell and a dead Pi. The owner scenario 1 violated E5 under `S-sync-block`:
synchronous waiting froze other actors for 300000 virtual ms. Its failed launch
cleaned the carrier, and its retry admitted a Worker. The focused baseline tests
checked these outcomes against real tool results and process truth.

## Missing evidence and stopped traces

P10 did not reproduce the expected violation. Legacy journal generations omit
`bootId` and `osBirthToken`; the monitor returns `not_applicable`. Some histories
have no carrier event fields at all. The harness did not invent exact-generation
evidence. Cursor replay ran, but P8/P9 lacked branch observation stamps. No cursor
safety claim follows from those runs.

Other non-applicable inputs:

- P1: exact durable process generation fields; P2: journal `process: gone` claims.
- P3/E1: a ruled freshness deadline; E2: a branch delivery latency bound;
  E3: a launch completion bound; E4: a blocked threshold.
- P7: journal appends with PTB tool-call origins. Disk sampling records observer
  origins and cannot identify the writing call.
- P4/E5/S2/S4: some histories have no ensure call or result.
- P5: some histories have no pane closure. P6: some have no launch reservation.
- S5: Team-update branch entries; S6: journal `suspectedHumanStop` fields.

S1 was witnessed 60 times and S2 48 times. S3 and S4 had no witnesses. S5 and S6
were non-applicable in every run. Absent witnesses and non-applicable verdicts
are not passes. The campaign test passed because it completed collection and
verified reproduction; the property campaign is incomplete and contains defects.

| Fixture | Stop reason |
| --- | --- |
| clock-gap | Replay bound exceeded. |
| pane-loss | A later kill targeted an absent process. |
| restart | The bd fake does not model `show`. |
| shutdown-resume | The lead actor was no longer live. |
| stale-binding | Cross-Session fork allocation is not modeled. |

The bound was 10000 scheduler steps and 3600000 virtual ms. The experiment did
not raise bounds or add behavior to make these five fixtures complete.

## Verification and interpretation

Typecheck passed. The campaign and independent monitor tests passed 43 checks.
The focused scenario, extraction, and core lane passed 22 checks. No broad
package test result is claimed for this composed checkout. Imported C3 history
tests require their integration tree and are outside this baseline lane.

The baseline supplies reproducible counterexamples for P4 and E5. P5 adds a
cleanup-policy question. The expected P10 and cursor findings remain untested
because their monitors require newer observable fields. This limits the mutant
baseline: absence of those violations is an instrumentation gap, not evidence
that baseline behavior satisfies the newer contracts.
