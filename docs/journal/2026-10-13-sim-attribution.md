# Simulator attribution and hydration race

Status: implementation and experiment complete. The P5 premise was disproved.
Architecture impact: none. Production and monitor verdict logic are unchanged.
Source: `970ca0d`, based on integration `7df11a8`.

## Process history

Every new `process.birth` and `process.death` includes `process.processKind`:

| Kind | Evidence |
| --- | --- |
| `worker_pi` | Pi launch environment supplies `PI_TEAM_MEMBERSHIP_ID`. The history retains that value as `process.membershipId`. |
| `lead_pi` | The explicit lead startup environment supplies `PI_AGENT_NAME=team-lead`. |
| `shell` | Herdr creates the pane shell. |
| `other` | No classified launch identity exists. PID reuse starts here. |

Worker classification records the launch's Membership association. It does not
prove startup admission. Admission remains a separate durable runtime fact.
Tests compare the launch association to that fact for the exact boot/PID/birth
identity. An unrelated process that reuses the PID has `other` kind and no
Membership. Earlier facts never change when a replacement starts.

These are additive optional fields in history version 1. Missing classification
means legacy history. Schedule behavior and runner `sim-c1/5` are unchanged.
Old receipts replay their schedule choices; new histories add classification.
Monitors do not yet consume these new fields. No E1 fix is claimed.

## P5 correction

The old report incorrectly described `v31-p5-minimal` as Pi quit. Its inputs are
`pi.start -> os.reboot`. The replay still closes the lead pane with OS origin and
P5 still reports a violation at sequence 14. Relabeling this close as human would
contradict the trace.

`sim/attribution.test.ts` verifies human Pi quit and a later explicit human pane
close through real extension hooks. Quit kills only Pi with human origin. The
shell survives until `human.closePane`. That close has human origin and passes
P5. This behavior needed no runtime fix. The Task's premise requires correction;
no new quit-and-close behavior was added.

## Hydration race

`sim/hydration-race.ts` adds the `snapshot-hydration` generated campaign family.
It delays external `bd` completion, starts a real `team_sync` snapshot, creates a
Worker through `ensure_worker`, clears the delay, and requests updates. The
Worker commits after the watermark and before Task hydration completes.

Three schedules use gaps 1, 25, and 50 ms and seeds 42, 20261013, and 12345.
The generator maps campaign gaps into the 1–50 ms hydration window.

| Observation | Control | M4 scratch mutation |
| --- | --- | --- |
| Snapshot workers | Empty | Empty |
| Snapshot cursor | 0 | 2 |
| Next observation | Creation and connection updates for `w-race` | `unsettled`, cursor 2; creation changes omitted |
| Existing P8 verdict | Pass | Pass |

The new focused regression passes on control and fails on M4's snapshot cursor.
This proves that the schedule reaches M4. It does not claim a P8 gate kill.
The unchanged P8 monitor still trusts the snapshot stamp without checking its
content. The scratch mutation was reversed and its production file matched the
checkout before scratch removal.

## Evidence and verification

Artifacts live in [`sim/results/attribution/`](../../sim/results/attribution/).
Each schedule has a trace, receipt, and semantic history projection. `M4/`
contains the corresponding scratch-mutation results. `M4/comparison.json`
records the source revision, patch digest, and focused regression failure.
No host paths or Session file contents are retained.

- Replayed the saved P5, E1, and M4 receipts without replacing their old evidence.
- Replayed all three new race schedules. Full histories matched their new
  receipt-driven replays under both control and M4.
- P5 remains an OS-origin violation. E1 remains an immediate-recovery violation
  at sequence 217. The old M4 witness still passes P8.
- `npm test`: 1874 passed, 3 skipped; 169 files passed, 2 skipped; 61.32 seconds.
  This includes typecheck and the new process/origin/race regression tests.
- Production and monitor directories have no diff from integration `7df11a8`.

Reproduce the control evidence with:

```sh
npx vitest run --config sim/attribution.config.ts
npx vitest run sim/attribution.test.ts sim/hydration-race.test.ts
```

To reproduce the mutation comparison, archive the source commit into an ignored
`.mutant-scratch-*` directory and link the existing dependencies there. Apply
`sim/mutants/M4.patch` only in that scratch tree. Run the campaign with
`PI_SIM_ATTRIBUTION_OUTPUT` set to a separate result directory. Run the focused
hydration regression there and expect one failure. Reverse the patch, compare
the production file with the source commit, then remove scratch. The existing
mutant campaign also includes the new family through `families`.

Remaining policy question: should P5 permit OS reboot closures? This Task leaves
that verdict logic unchanged. A separate quit-and-close input would need an
explicit scope decision. No implementation blocker remains.
