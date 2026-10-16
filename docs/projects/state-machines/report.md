# PTB state machines: experiment report (Membership carrier)

Status: experiment result for owner decision. Branch `sm-experiment`,
`0f39e06..d645d46`, not pushed. Date: 2026-10-16.

## Answer

The Membership machine is possible at low cost. It found more than the live
incident showed, and it removed a policy override and four bypass writers.

- **Possibility: high.** The machine became the production writer without a
  change to the on-disk format. Every old record shape parses.
- **Complexity: low in the reducer, high at the effect boundary.** The
  reducer is 258 lines. The hard part was a question about the shell: when
  can a process exist? That needed a provenance rule and an explicit
  actuation point.
- **Benefit: real, and larger than a patch.** A 6-line control fix stops the
  live wedge. It still writes a record on each refused spawn, reports
  `created` for a failed spawn, and never retries a stuck launch.

Recommendation: merge the Membership machine after the gates pass. Close the
two open obligations below before a second machine.

## What was built

```
durable Member --parseMembership--> MembershipState (union)
State x Event --transitionMembership--> applied{state, patch} | unchanged | refused
shell: lease -> read -> preflight -> applyMembershipEvent -> effect -> event
```

| Commit | Change |
| --- | --- |
| `6faece7` | Machine, `mayOwnProcess` provenance rule, exhaustive explorer |
| `c082a12` | `applyMembershipEvent` becomes the single production lifecycle writer |
| `4929f84` | Refused spawn writes nothing; pre-actuation failure records `refused`; stop accepts `no_process_possible` |
| `17562e1` | Expired unstarted Herdr launch retries; the planner owns `launch_pending` |
| `4b8305c` | Simulator replay of the geometry wedge |
| `8bd7fff` | Simulator conformance checker with event witness and effect check |
| `0d7741f` | Four unused bypass writers deleted; stop authority required |
| `d645d46` | All pre-actuation construction inside the refusal path; live-phase stop tests |

## Evidence

### Simulator wedge replay (`sim/membership-wedge.test.ts`)

Fill the pane geometry. Refuse two spawns. Stop one Worker. Spawn again. Stop
every refused Worker.

| Measure | rc.4 | control (6 lines) | machine |
| --- | --- | --- | --- |
| Over-capacity spawns | 1st `created` (false), 2nd refused | both `created` (false) | both refused with the geometry cause |
| Later spawn's refusal cause | blames `refused-1` | `created` (false) | geometry |
| Stops of refused Workers | 0 of 3 | 3 of 3 | 3 of 3 |
| Unstoppable residue | 3 | 0 | 0 |

Outputs: `/tmp/ptb-sm/wedge-sim-{rc4,sm-control,sm}.json`.

### Regression tests (`membership-wedge.regression.test.ts`)

Six tests pass on the machine. The four original tests fail 3 of 4 on rc.4 and
3 of 4 on control:

1. a refused placement writes nothing;
2. a pre-start failure is `refused`, placement passes it, and stop works;
3. an expired unstarted launch retries, and a fresh one stays pending.

On control, test 2 fails at its first assertion, so the test does not reach
control's stop rule. Control's stop works in the simulator replay above.

### Live wedge records

The seven target-less records from the live Team ran on a real-filesystem
Team with a mocked Herdr. The temporary test was not committed because the
records hold private names.
- `ensure_worker` on the `unknown` record returned `recovered` through
  `first_binding_retry`.
- `worker_stop` stopped all six `requested` records with no terminal kill.
- On rc.4, every record needed a manual JSON edit.

### Explorer (`membership-machine.explore.test.ts`)

- It reaches 3,154 records and 96,716 transitions per carrier kind in 0.6 s.
- Seven invariants hold on every transition.
- Human-only states are states that no tool can stop:

  | Stop rules | Two-stage (Herdr) human-only states |
  | --- | --- |
  | rc.4 | 45 (the wedge) |
  | machine | 1 |

  The one remaining state is a pre-rc.1 prepared record without a `launch`
  fence. It stays fail-closed by design.
- One-stage carriers keep 34 human-only states. Each one is an unrecorded
  start, and fail-closed is correct for it.

### Conformance (`sim/membership-conformance.test.ts`)

- **Corpus:** 44 runs: every fixture, three generated schedules per v3.1
  family, and the wedge replay.
- **Result on the machine:** 202 Membership changes and 65 Herdr starts. Each
  change matched one machine transition, and each start followed a requested
  launch that targets its pane. There were 0 violations.
- **Negative traces:** the checker rejects three forged traces: a changed
  Session, a capability change without relaunch, and a start before the
  target record.
- **Result on rc.4:** rc.4 also conforms, with 191 changes. So the wedge was
  not a bad write. It was a transition that the rc.4 shell never took. The
  explorer's human-only count finds that class. Conformance does not.

### Gates

Gates at `d645d46` (`/tmp/ptb-sm/gates-d645d46.md`):

| Gate | rc.4 | `d645d46` |
| --- | --- | --- |
| typecheck | pass | pass |
| `npm test` | 2,109 tests pass | 2,148 tests pass |
| campaign + v3.1 receipts | 4 pass | 4 pass |
| test lanes | 208 / 184 / 24 | 212 / 188 / 24 |
| exhaustive lane | not run | 1 failure: the tool-result QA suite |

`adba806` fixes the QA failure. The QA suite now passes on sm and rc.4:
- **Cause:** the QA fake terminal had no `prepareSpawn`. Every QA spawn
  failed and reported `created`.
- **Hidden dependency:** the suite's second Worker existed only as the
  residue of a refused spawn.
- **Remaining gap:** the full Team shutdown now runs for the first time in
  this suite. It throws in the harness because the harness never sends
  `session_start`. Production always sets that context. The QA
  `team_create` case already fails on rc.4 for the same reason.

Timing: `npm test` took 137 s on `d645d46` against 69 s at baseline. Task
hydration p50 went from 0.1 ms to about 0.2 ms. Both runs shared the machine
with another full lane, and the diff changes no Task-hydration code. A
quiet-machine rerun is still due before merge.

## Cost

| Item | Lines |
| --- | --- |
| Production | +423 −167 in 8 files; the machine is 258 of the added lines |
| Tests | +444 −64 |
| Simulator library | +149 |
| Lifecycle writes through generic patches in production | 5 → 0 |
| Exported bypass writers | 4 → 0; `addMember` remains the constructor |
| Policy overrides outside the planner | 1 → 0 |

The ensure reuse path makes no new calls. The preflight runs only on paths
that write. Timing: see Gates.

## What the machine found that the incident did not show

1. A refused spawn wrote one durable record per call.
2. A pre-start failure inside the launch was swallowed and reported as
   `created`. The model saw success.
3. A launch that never recorded a target waited for `launch_pending`
   forever. No tool could retry it.
4. The bridge overrode the planner's decision after the planner returned it.
   It also hid invalid records as `launch_pending`.
5. The tool-result QA suite had never launched a Worker since its fake
   terminal lost `prepareSpawn`. Its partial-shutdown case depended on the
   wedge residue (`adba806`).
6. Target absence proves no process only with provenance: a refused launch,
   or a Herdr launch fence (`14d4694`). Legacy records stay fail-closed. The
   systems observer found this; the reducer made it a single predicate.

## Limits and open obligations

From `/tmp/ptb-sm/review-systems-2.md` and `/tmp/ptb-sm/review-product-2.md`:

1. **Orphan panes (systems, high).** A Herdr split can succeed, then the
   target write can fail or the reply can be lost. A retry then leaves the
   first pane untracked. The machine models durable state; it does not own
   panes. Next test: split, crash before the target write, retry after 15 s,
   then deliver the old reply. Decide between automatic reconciliation and
   explicit attention.
2. **Operator surface unchanged (product).** `reason` is still a `string`.
   `launch_pending` and `first_binding_retry` are not in the skill. The
   placement message names the blocker but no action.
3. **Liveness is structural.** The explorer proves that a stop path exists
   under supplied evidence. It does not prove fair progress.
4. **Trusted events.** The reducer trusts `complete_launch: refused` and stop
   authority. The shell must supply true evidence. The conformance effect
   check covers starts only.
5. **Invalid records** have no tested tool exit.
6. **Decision cost** is not measured by an independent prediction exercise.

## Assessment for further machines

- The pattern pays where lifecycle state is durable and several writers
  touch it. Membership met both conditions.
- The reducer is cheap. The effect boundary is the real work. Budget for
  effect ordering, provenance and adapter capability, not for state tables.
- Conformance proves that writes are lawful. Only the explorer's human-only
  count found the wedge. Each machine needs both checks.
- Next candidate: the Task delivery record (`src/utils/task-delivery.ts`). It
  has durable intents and retries. First close obligations 1 and 2 above.

## Side finding (PTB)

Re-applying a graph with changed goal text on finished Tasks reopens them as
`ready`. Workers then claim them again. This happened during the experiment.

## Decision requested

Merge `sm-experiment` into main for rc.5 after a quiet-machine timing rerun, with
obligations 1 and 2 as rc.5 follow-ups. Evidence that would reverse this: a
gate failure or a startup regression.
