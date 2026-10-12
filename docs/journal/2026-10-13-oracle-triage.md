# Oracle triage: P3, P8, E1, E2, E3, P5

Status: triage complete. One production defect candidate remains (PD-1). Architecture
impact: none. Production code (`src/`) was not changed. This is not a conformance pass.

## Source bundle

- Branch `v31-props`. Merges of `v31-integration` and `v31-sim` are in history.
- Monitor and test changes: `sim/monitors/*.ts`, `sim/v31-campaign.test.ts`.
- Campaign: `sim/v31-campaign.config.ts`, 1045 outcomes, runner `sim-c1/5`, seed 20261014.
- Canonical result: `sim/results/v31/campaign.json`.
- Counterexamples: `E1.{trace,receipt,evidence}.json` in `sim/results/v31/`.

```sh
npx vitest run sim/monitors
npx vitest run --config sim/v31-campaign.config.ts
```

## Lead rulings applied

| Ruling | Monitor | Change |
| --- | --- | --- |
| P3 judges served claims against world truth | P3 | Violation only when a live claim names a generation dead for more than `LIVE_GRACE_MS` (10000 ms virtual). Journal-transition age alone does not violate. Tool results with `details.process === "live"` count as claims. |
| E1 considers Worker Pi only | E1 | Filters on `processKind === "worker_pi"` with `membershipId`. Satisfied by a journal `process: gone` row for the exited generation, or by a replacement key that names it. |
| E2 measures from lead idle | E2 | Starts at the first `agent.settled` world input after the append. N/A when the lead never settles in the window. |
| E1-E4 fault windows are N/A | E1-E4 | `faultInWindow` returns N/A under assumption. |
| P8 must fail a page that omits events (M6) | P8 | A page's range `(from, through]` must name each journaled event's worker in the page content. |
| P5 judges PTB-origin closes only | P5 | Skips every close whose origin is not `ptb`. |

## Monitor fixes

- **P3.** The old check fired on journal-transition age. The new check reads the
  claim against world death. Earlier count: 306 violations. Final: 0.
- **P5.** The old check judged an OS-origin close (`pi.start -> os.reboot`). That close
  is not a PTB act. Earlier count: 1. Final: 0.
- **P8.** The first correction read worker names from `details`. Production puts
  the page's worker list in the text `content` JSON (`workers` on a snapshot,
  `workerChanges` on an update). A monitor that read `details` raised 110 false
  positives. The corrected monitor reads the content JSON and the M6 test still fails.
  Final: 0 violations.
- **E2.** Earlier count: 876. Final: 0. Most cases now N/A because the lead did not
  settle in the window (935 N/A).
- **E3.** Earlier count: 110. Final: 0. The windows contain a fault (102 N/A).
- **E1.** Earlier count: 323. Final: 104. The `processKind` filter removes non-worker
  exits. I did not isolate which change removed the 219 non-worker cases. The
  remaining 104 are PD-1.

## Example histories

- **P8 M4 control** (passes): snapshot through 0, then the Worker creation update
  through 2 names `w-race`. Hand-built from `sim/results/attribution/M4/comparison.json`.
- **P8 M4 scratch** (violates): snapshot through 2 with no Worker creation changes.
  The scratch history is not stored as a file. Only `comparison.json` summarizes it.
  The example is hand-built from that summary and is labelled as such.
- **P8 M6** (violates): a page through 2 omits event 2 (`w2`).

## Campaign result (final run)

| Monitor | Violation | Pass | N/A | Note |
| --- | --- | --- | --- | --- |
| P1 | 0 | 1045 | 0 | |
| P2 | 0 | 359 | 686 | |
| P3 | 0 | 299 | 746 | Monitor fix. |
| P4 | 0 | 1043 | 2 | |
| P5 | 0 | 194 | 851 | Monitor fix. |
| P6 | 0 | 1043 | 2 | |
| P7 | 0 | 0 | 1045 | |
| P8 | 0 | 1034 | 11 | Monitor fix. |
| P9 | 0 | 1035 | 10 | |
| P10 | 0 | 280 | 765 | |
| E1 | 104 | 359 | 582 | PD-1. |
| E2 | 0 | 110 | 935 | Monitor fix. |
| E3 | 0 | 943 | 102 | Fault-window N/A. |
| E4 | 0 | 0 | 1045 | |
| E5 | 0 | 1043 | 2 | |

Witnesses (S1-S6) are absent or witnessed. They do not produce pass or violation.

Scale: 20 isolated teams x 50 workers, and shared world 3 x 10. The 20 x 50 shared
world remains untested.

## Remaining violations

### PD-1: superseded worker generation exit not journaled

Class: production defect candidate. Owner confirmation needed on the reading of E1.

Symptom: after a Worker Pi generation dies, a replacement generation binds and
journals. No journal row says the old generation ended. In 60 s virtual, E1 finds
no `process: gone` row and no replacement key that names the old generation.

Mechanism (read from code, not yet confirmed by a fix or a trace on production):

- `src/carrier-observation.ts:246` refuses a publication when the current runtime
  generation differs from the view's generation. A replacement that lands before
  the observer samples the death therefore drops the old generation's `gone`
  publication.
- The replacement journal row (`session_bound`, new pid) does not name the
  superseded generation.

Receipts:

- Minimal trace: `v31-e1-minimal`, seed 42, 6 steps, files `sim/results/v31/E1.trace.json`
  and `E1.receipt.json`. Death of `team-1/w1` pid 104 at seq 217. Replacement
  `session_bound` row for pid 106 at seq 285. No `gone` row for pid 104 within 60000 ms.
- Campaign: 104 E1 violations. 103 are `v31-generated-N` (family `pid-reuse`),
  1 is `v31-pid-reuse`. I regenerated all 103 with `fc.sample` (seed 20261014,
  numRuns 1000) and replayed them. All 103 reproduce, and the history length matches
  the campaign outcome.

Reading to confirm: the lead ruling counts a replacement only when it names the
old generation. Under that rule, the replacement row lacks the reference, so the
violation stands. If the owner accepts that a generation never seen live needs no
`gone` row, E1 should instead report N/A for those windows.

## Limitations

- P8 matches worker names by key (`workers`, `workerChanges`, `worker_changes`).
  Production uses the first two. The third is a guess kept for robustness.
- P3 tool-result claims use field names from the plan. They are not checked against
  a PTB wire spec.
- E1 replacement keys (`previousGeneration`, `replacedGeneration`, `replaces`) are
  guesses. The production journal writer does not emit any of them. This means
  the replacement path of E1 cannot pass on production data today.
- The M4 scratch example is hand-built. The M4 control replay is in
  `sim/results/attribution/M4/`.
- A `pass` in the campaign does not prove conformance.
