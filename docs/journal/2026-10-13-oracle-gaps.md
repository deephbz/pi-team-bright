# Oracle gaps: four false negatives closed

Status: complete for the four probe cases. Campaign and mutant rerun done.
Architecture impact: none. Production code (`src/`) was not changed by this
task. The merge brought in production commits from `v31-liveness`. This is
not a conformance pass.

## Source bundle

- Branch `v31-props`. Merged `v31-integration` at `63edab9`.
- Monitor commit: `fec686e`. Mutant runs used this revision (HEAD of the run).
- Probe: `/tmp/ptb-state-liveness/final-oracle-probe.mjs`. Its root was
  copied and changed to `ptb-wt/props` in a scratch file. The original reads
  the `integration` tree, which has the old monitors.
- Campaign: `sim/results/v31/campaign.json`, 1045 outcomes.
- Mutants: `sim/results/mutants-oracle-gaps/{M1..M6}/result.json`.

## Four monitor errors fixed

Each probe case was a false negative: the monitor passed a history that
violates the rule. All four are monitor errors. No production defect is
implied.

| Probe case | Before | Monitor change | After |
| --- | --- | --- | --- |
| `omittedTask` (P8) | pass | P8 also requires each Task event's `ref.taskId` in the page (`tasks[].id`, `taskChanges[].taskId`). | violation |
| `requestedOnly` (E3) | pass | A launch row resolves the reservation only when `to` is `started`, `refused`, or `unknown`. | violation |
| `unrelatedStop` (P5) | pass | A PTB close needs a stop whose target owns that pane. `worker_stop` names a Worker in `args.worker`. `team_shutdown` covers any pane. | violation |
| `alreadyIdle` (E2) | N/A | If the last lead input before the append is `agent.settled`, the window starts at the append. | violation |

Notes on the probe:

- The probe wrote the stop target as `args.name`. The production schema for
  `worker_stop` uses `args.worker` (`WorkerStopParametersSchema`). The monitor
  reads `args.worker`. The passing counterpart uses `worker`.
- The probe's Task event carries `ref` at the top level. Production carries it in
  the raw line. The monitor reads `raw.ref.taskId`.

Each case has a violating example and a passing counterpart in
`sim/monitors/monitors.test.ts`. Result: `npx vitest run sim/monitors` passes
65 of 65. `tsc` is clean for `sim/`. The probe, on the `props` tree, reports
`violation` for all four cases.

## Campaign (final rerun, `fec686e`)

| Monitor | Violation | Pass | N/A | Note |
| --- | --- | --- | --- | --- |
| P1 | 0 | 1045 | 0 | |
| P2 | 0 | 465 | 580 | Changed from 359 pass. Production merge. |
| P3 | 0 | 299 | 746 | |
| P4 | 0 | 1043 | 2 | |
| P5 | 0 | 194 | 851 | |
| P6 | 0 | 1043 | 2 | |
| P7 | 0 | 0 | 1045 | |
| P8 | 0 | 1034 | 11 | |
| P9 | 0 | 1035 | 10 | |
| P10 | 0 | 280 | 765 | |
| E1 | 0 | 465 | 580 | Was 104 violations. Production merge (see below). |
| E2 | 0 | 110 | 935 | |
| E3 | 0 | 943 | 102 | |
| E4 | 0 | 0 | 1045 | |
| E5 | 0 | 1043 | 2 | |

Witnesses (S1-S6) are absent or witnessed. Counts: S1 176 witnessed, S2 72,
S3 109, S4 98, S5 110, S6 192. S6 N/A moved from 107 to 105. This comes from
the merge.

### New violations from the campaign

None. The campaign shows zero violations for every monitor.

### Attribution of the E1 and P2 change

The previous campaign (`714e9c0`) had 104 E1 violations. Those were the
PD-1 candidate in `oracle-triage`. This step did not change E1 or P2 logic
in the monitors. The change comes from production commit `d391699`
("publish verified predecessor exit before runtime replacement"), which is an
ancestor of `HEAD` through the `v31-integration` merge. PD-1 is therefore
closed by a production change. This report did not re-verify that fix
mechanism beyond the campaign outcome.

E2 counts did not change (110 pass, 935 N/A). The `alreadyIdle` rule did not
fire in any campaign history. The campaign never appended while the lead was
already idle. The rule is covered by the probe and the example tests only.

## Mutant verdicts (runner at `fec686e`)

| Mutant | Verdict | Killed by | Note |
| --- | --- | --- | --- |
| M1 | killed | P4 | Control passes. |
| M2 | killed | retry | Control passes. |
| M3 | survived | none | E3 passes on control and mutant. See below. |
| M4 | killed | P8 | Page omits `w-race`. |
| M5 | killed | E5 | Receipt took 300000 ms against a 10000 ms bound. |
| M6 | killed | P8 | Page omits `extra-29`. P9 passes. |

M3 survives by design. The mutant returns `receipt_deadline` at 10000 ms and
records `launch: unknown`. No Worker starts. E3 allows completion or unknown.
The decision record for this is in `docs/journal/2026-10-13-mutant-gate.md`
(section "M3: intended bounded unknown defense"). The same verdict appeared in
the earlier recheck.

## Limitations

- P8 covers Worker and Task events only. Other journal events (team lifecycle
  and similar) have no page name in this monitor. They are not judged.
- P8 Task names come from the production contract as read in source. The
  campaign has not been checked for Task events that a page omits. Pass counts
  are unchanged.
- P5 maps a pane to a Worker through journal rows with `paneId`. A close with
  no earlier row for its pane counts as unauthorized. This is strict. The
  campaign shows no violation.
- E3 resolves only on journal rows and durable records. Membership is matched
  from the normalized event field. Production placement of that field was not
  re-checked in this step.
- The `alreadyIdle` rule has no campaign coverage.
