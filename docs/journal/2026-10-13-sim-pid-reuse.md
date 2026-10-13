# Simulator actor generation repair

Status: complete. Owner decision: D6=A.
Architecture impact: none. Production, monitors, and deployment are unchanged.
Base: `045765850e71a6b449038751b52b9593b87796e7`.
Implementation: `558c199` on `v31-sim`. No push, publication, or release.

## Observed failure and repair

The reported 60 stopped PID-reuse cases did not reproduce on the merged base.
The retained v3.1 campaign at `467143c` contains 103 generated PID-reuse cases;
all 103 completed. Its fixed PID-reuse schedule also completed. The earlier
`da68cf8` change had already replaced the numeric-PID liveness guard.

New regression tests exposed remaining generation errors:

- `pi.start` selected the old actor by Team/name after PID reuse or reboot.
  Both restart tests failed with `Actor is not live`.
- A stale Worker object entered its replacement's environment by Team/name.
  The stale object's `emit` resolved when it should have rejected.
- After selecting a new generation, a resume initially allocated a new Session.
  An exact-Session regression exposed this during implementation.

The repair changes simulator ownership at the actor boundary:

- `WorldReplay.actors` uses `(bootId, pid, osBirthToken)` as its key. It retains
  dead actor instances. A role lookup selects the current process generation.
- Each `SimActor` captures an immutable generation. Event entry, tool entry,
  initialization, and settle reject a stale generation.
- Explicit startup allocates a new process when the prior process is dead.
  A reused numeric PID cannot restore the old actor.
- Explicit resume resolves the prior exact Session through the trace Session
  reference. Process replacement does not replace that Session.
- Replay actor results include `generation` and `alive`. Multiple results can
  share a role name across successive generations.

`sim/pid-reuse.test.ts` owns four regressions: same-role/same-PID replacement,
stale Worker handles while an outsider holds the old PID, reboot identity,
and exact Session resume. The first three failed before the repair. All four
pass. The reboot test also compares the full receipt-driven replay history.
The existing `sim/campaign-faults.test.ts` PID-reuse regression still passes.

## Verification and count changes

- `npm run typecheck`: passed.
- `npx vitest run sim --reporter=dot`: 129 tests passed in 17 files; 12.52 s.
- Exhaustive `sim/campaign.test.ts`: passed; all 12 generated variants replayed
  twice. Six of ten fixtures replayed twice. The remaining four stop explicitly.
- Identical v3.1 smoke command before and after:
  `PI_SIM_CAMPAIGN_RUNS=2 npx vitest run --config sim/v31-campaign.config.ts`.
  Both runs passed. The smoke includes all fixtures, three baseline traces,
  eleven fixed schedule families, two generated samples, one 1-by-2 shard,
  and one shared 3-by-10 world.

| Smoke outcome | Base | Repair |
| --- | ---: | ---: |
| Total schedules | 28 | 28 |
| Completed | 23 | 24 |
| Stopped prefixes | 5 | 4 |
| P9 pass / not applicable | 18 / 10 | 19 / 9 |
| Campaign time, including scale | 78.110 s | 34.306 s |

`synthetic-shutdown-resume` is the only changed schedule outcome. It now resumes
its exact Session on a new generation. P9 gains one applicable passing history.
All other property/witness counts are unchanged. Neither smoke has a property
violation. Timing is a single-run observation, not a performance claim.

The four remaining stopped fixtures are `clock-gap` (replay bound), `pane-loss`
(absent process), `restart` (unsupported `bd show`), and `stale-binding`
(unsupported cross-Session fork). This Task does not repair those boundaries.
No new 1000-run or 60-case campaign claim is made.

Machine summaries are in
[`sim/results/pid-reuse/`](../../sim/results/pid-reuse/). They retain exact source
revisions, seeds, samples, bounds, outcome counts, and monitor options.
The temporary smoke output was removed after retaining these summaries.
A base-relative diff confirms no changes under `src`, `extensions`, or
`sim/monitors`. The privacy gate passed on the implementation commit.
