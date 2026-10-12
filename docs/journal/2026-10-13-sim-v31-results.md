# v3.1 simulator campaign

Status: completed experiment with findings and coverage limits. Architecture
impact: none. Production code was not changed. This is not a conformance pass.

## Source bundle and reproduction

The liveness ancestry gate passed before execution. The simulator branch merged
`v31-integration` at `1a8a3f663ab04622ee909823ae349da0f94ce245`, which contains
`v31-liveness` at `677d11e0708df4742626ff06ceaad92d6d541ef0`.

- Production condition: `1a8a3f6`, including C2 and C3.
- Schedule and fault support: `da68cf8`, followed by the oracle plumbing and
  campaign sources committed with this report. Runner: `sim-c1/5`.
- Independent monitor verdict logic: `461aa39`. Only the journal field accessor
  changed. Safety, liveness, witness logic, and their existing tests are unchanged.
- Driver and generator: `sim/v31-campaign.test.ts`, `sim/v31-schedules.ts`.
- Canonical result: `sim/results/v31/campaign.json`.
- Counterexamples: `{P3,P5,E1,E2,E3}.{trace,receipt,evidence}.json` in that directory.

```sh
npm run typecheck
npx vitest run --config sim/v31-campaign.config.ts --reporter=verbose
npx vitest run --config vitest.exhaustive.config.ts sim/v31-receipts.test.ts --reporter=verbose
npx vitest run sim/monitors sim/history.test.ts sim/campaign-faults.test.ts --reporter=verbose
```

The campaign command rewrites its artifacts. The receipt lane verifies the
persisted counterexamples without rerunning the full campaign. Fixtures,
schedules, receipts, and evidence extracts contain synthetic identities only.
Full raw histories remain transient.

## Oracle plumbing and bounds

The lead authorized these adaptations to the real production wire shape:

- `sim/history.ts` adds typed carrier fields. `sim/history-observer.ts` reads
  `raw.carrier` and derives numeric `seq` from a safe persisted cursor value.
  The canonical `raw` object remains unchanged.
- `sim/monitors/util.ts` returns a compatibility view from those typed fields.
  It maps the production `blocked` publication to the monitor's `attention`
  field name. It exposes `cause.source` through the legacy cause accessor.
  No verdict branch, deadline comparison, or expected test verdict changed.
- `sim/monitors/production-shape.test.ts` adds nine production-shaped cases:
  P2, P3, P8, P10, S6, and E1–E4. All 42 existing monitor tests still pass.

Explicit virtual-time options are P3 `freshnessMs: 10000`, E1
`deadlineMs: 60000`, E2 `latencyMs: 60000`, E3 `boundMs: 60000`, E4
`thresholdMs: 60000`, and E5 `boundMs: 10000`.

E1–E4 require a fault-free 60000 ms window after the monitor's triggering fact.
The report retains raw verdicts and separately classifies this assumption.
Generated schedules clear source faults by 15000 ms and finish at 100000 ms.
An early trigger can still fall inside a fault window. Such a verdict does not
establish a failure under the fault-free assumption. Shrinking preserves the
original assumption classification.

## Coverage and runtime

The final campaign evaluated 1044 histories with all 21 monitors:

- Ten synthetic fixtures, including both owner scenarios.
- Three baseline counterexample traces.
- Ten fixed adversarial schedule families.
- 1000 fast-check generated schedules, all completed. Seed: `20261014`.
  Each sample records its scheduler seed, timing gap, family, and repetition
  count. Fixed schedules and scale runs use scheduler seed `42`.
- Twenty isolated Team shards with 50 Workers each, plus one shared world with
  three leads and ten Workers per lead. All 21 scale runs completed. Observed
  Worker births were 50 per shard and 30 in the shared world.

The ten generated-family counts were PID reuse 123, Herdr loss during launch
109, reload storms 99, compaction 136, contended reservations 79, source-TTL
expiry 59, delayed source completion 93, append ambiguity 105, human stop 108,
and crash-before-record 89. PID-reuse schedules vary preceding Worker launches
to vary numeric PIDs and birth order. The append ambiguity fault fired 399 times
across the complete campaign.

Wall time was 440.647 s for fixtures and generated schedules, and 767.429 s
including scale and shrinking. Vitest took 768.32 s. These are single-trial
measurements under host load. Replay bounds were 100000 scheduler steps and
3600000 virtual ms per history.

The scale result does not cover twenty concurrent leads with 1000 Workers in
one shared world. A preliminary monolithic attempt exhausted the 65536-draw
entropy tape after 76 Worker births. The lead approved the shard design and the
smaller shared-world run. The final result makes no large shared-world claim.

## Property outcomes

Counts include the five stopped fixture prefixes. A prefix cannot establish
whole-trace conformance. `N/A` names missing input and is never a pass.

| Property | Pass | Violation | N/A |
| --- | ---: | ---: | ---: |
| P1 | 1044 | 0 | 0 |
| P2 | 447 | 0 | 597 |
| P3 | 447 | 306 | 291 |
| P4 | 1042 | 0 | 2 |
| P5 | 200 | 1 | 843 |
| P6 | 1042 | 0 | 2 |
| P7 | 0 | 0 | 1044 |
| P8 | 1033 | 0 | 11 |
| P9 | 1034 | 0 | 10 |
| P10 | 281 | 0 | 763 |
| E1 | 341 | 323 | 380 |
| E2 | 166 | 876 | 2 |
| E3 | 932 | 110 | 2 |
| E4 | 0 | 0 | 1044 |
| E5 | 1042 | 0 | 2 |

All sometimes witnesses were reached: S1 219 times, S2 80, S3 90, S4 110,
S5 137, and S6 199. The machine result retains absent and N/A outcomes too.

The owner scenarios and all three baseline counterexample inputs pass P4 and
E5. They produce no pane closure, so P5 is N/A. The old `sim-c1/3` baseline
receipts are rejected by the explicit runner-version guard. The inputs were
rerun on `sim-c1/5` with their original seeds. This is cross-version input
comparison; it is not an assertion that two implementations have the same
scheduler tape.

## Minimized findings and interpretation

Each saved receipt reproduces the complete typed history and monitor verdicts.
The separate persisted-receipt lane also reproduced all five findings.
Traces are 1-minimal under single-step deletion and reduction of one timestamp
to its predecessor, restricted to runtime-valid traces with the same temporal
assumption classification. This does not claim global minimality.

| Property | Trace id | Steps | Shrink attempts | Observation |
| --- | --- | ---: | ---: | --- |
| P3 | `v31-p3-minimal` | 4 | 28 | One `process: live` journal transition is followed by more than 10 s without another transition. |
| P5 | `v31-p5-minimal` | 2 | 14 | Pi quit closes the lead pane with OS origin. |
| E1 | `v31-e1-minimal` | 6 | 32 | The Worker dies and immediately recovers; no non-live journal transition appears within 60 s. |
| E2 | `v31-e2-minimal` | 4 | 18 | A prepared event does not reach the branch within 60 s. The lead never settles. |
| E3 | `v31-e3-minimal` | 5 | 38 | A launch reservation receives no matching resolution while Herdr stays unavailable. |

Interpretation remains separate from those observations:

- P3 measures journal-transition age. The observer refreshes source evidence
  without appending an unchanged transition. The trace alone does not establish
  that the current carrier view held stale evidence. Review the oracle's evidence
  target before treating this as a production defect.
- P5 follows the current simulator's Pi-quit pane behavior. The quit input is a
  human action, but the resulting closure has OS origin. This is an attribution
  or model-policy question. It is not evidence of an unsolicited stop tool call.
- E1's minimized trace exercises immediate recovery. A poll can miss the transient
  death before the replacement binds. Other E1 findings include shell exits,
  which this monitor currently treats as Worker exits. Review the intended
  observation contract and process classification.
- E2's fault-free window is satisfied, but its minimal lead has no settled input.
  The monitor measures from event append; it does not model idle eligibility.
  The production contract delays automatic delivery until idle. This limits the
  finding's product interpretation.
- Every E3 violation has a fault inside its window. The minimized trace retains
  Herdr unavailability. None establishes a failure under the stated fault-free
  assumption.

Of the E1 violations, 233 have fault-free windows and 90 have faults. E2 has 395
fault-free and 481 faulty windows. E3 has 110 faulty windows. These classifications
address source faults only; they do not prove idle eligibility or correct
process classification.

## Remaining coverage limits

Five original fixtures stop explicitly:

| Fixture | Stop reason |
| --- | --- |
| clock-gap | Replay bound exceeded before its day-long gap completed. |
| pane-loss | A later kill targets an absent process. |
| restart | The bd fake does not implement `show`. |
| shutdown-resume | The lead actor is no longer live. |
| stale-binding | Cross-Session fork allocation is not modeled. |

P7 remains N/A because disk sampling cannot assign journal writes to a PTB tool
call. E4 remains N/A because these replay histories contain no activity-blocked
transition. Its production-shaped accessor test passes, but that does not replace
end-to-end debounce coverage. P10 still encounters legacy `session_bound`
generation fields without exact boot/birth tokens and stops as N/A. Other N/A
results lack the specific trigger, closure, stamp, journal row, or reservation
that their monitor requires; the machine result names every missing input.

The runner's dead-actor guard previously checked numeric PID occupancy. The
campaign exposed a model failure after PID reuse. The simulator now checks its
captured actor generation. A focused replay proves that an unrelated live
process can retain the old PID while a replacement Worker starts. No production
algorithm changed.

## Verification

Typecheck passed. The final campaign test completed. The focused oracle,
production-shape, history, and source-fault lane passed 60 tests. The persisted
counterexample lane passed five tests. Before oracle normalization, the focused
core, async-host, fixture, extraction, and fault lane passed 29 tests. No full
package test claim is made for this source bundle. Privacy and production-diff
checks accompany the commit.

## Correction: P5 attribution

The P5 interpretation above is incorrect. The retained two-step trace is
`pi.start -> os.reboot`. It contains no Pi quit. Reboot closes the pane with OS
origin. That attribution matches the input. The unchanged P5 monitor rejects
OS-origin closures because it permits only human actions and PTB stop requests.

The new [attribution verification](2026-10-13-sim-attribution.md) confirms that
human Pi quit kills Pi with human origin and leaves its shell alive. A subsequent
`human.closePane` kills the shell and closes the pane with human origin. The
original trace and receipt remain unchanged. This correction supersedes the P5
observation and interpretation above; it does not turn the P5 verdict into a pass.
