# Empirical and generated replay comparison

Status: completed bounded experiment. Architecture impact: none.
No production, simulator, or monitor code changed.

**No empirical trace completed on either target.** Historical argument redaction
and missing initial-world support stopped all 406 traces. The generated cases
show narrower improvements. They do not establish empirical conformance.

## Inputs and execution

- v3.1 code: `1a8a3f663ab04622ee909823ae349da0f94ce245`.
  It contains `v31-liveness` at `677d11e0708df4742626ff06ceaad92d6d541ef0`.
- Baseline production: `14d92fdc2c7cf0b21f6853ba495d828350901e03`.
  Read-only baseline harness: `2a56ea98d07d20763146a432df9ddee93764b301`.
  Its production diff consists of the previously approved Worker-schema
  extraction. It has no C2/C3 implementation.
- Runners: baseline `sim-c1/3`; v3.1 `sim-c1/4`. The newer runner adds
  Session recovery and context events. This is a composed-system comparison;
  it does not isolate the production change from runner changes.
- Both targets used the same 406 private traces, ten current synthetic
  fixtures, and 200 generated variants. All 21 monitors ran on every history,
  including stopped prefixes. Monitor source is identical between targets.
- Fixed-input scheduler seed: 42. Generator seed: 20261013. Fast-check 4.10.2
  selected five fixture templates, scheduler seeds, and 0–40 ms delays for
  timestamps at or above 2 ms. Node: 25.6.0.
- Bounds: 10000 scheduler operations and 3600000 virtual ms. Monitor defaults
  were unchanged. E5 has a ruled 10000 ms bound. Other missing deadlines stayed
  unavailable.

The corpus predates the assumption registry. Replay changed only extraction
assumption labels from `A-*` to their registered `S-*` equivalents, plus target
version metadata. It did not repair tool names, arguments, setup, or steps.
Original source digests remain in the private results.

Each target attempted 616 inputs. Baseline completed 205 and stopped 411.
v3.1 completed 145 and stopped 471. Wall times were 162.133 s and 111.946 s.
The targets ran concurrently. Timing is not a performance comparison.

## Empirical classes

Classes below derive from retained world inputs. Rows overlap. The extractor
persisted incident totals but did not persist per-trace diagnostic labels.
Runtime-only restart and stale-binding findings therefore cannot be joined to
individual traces. This experiment does not guess those labels.

| Retained input class | Attempts per target | Completed, baseline / v3.1 | Violating prefixes, baseline / v3.1 | Argument stops per target | Setup stops per target |
| --- | ---: | ---: | ---: | ---: | ---: |
| Restart input | 2 | 0 / 0 | 0 / 0 | 1 | 1 |
| Abort / Escape candidate | 87 | 0 / 0 | 0 / 0 | 34 | 53 |
| Repeated explicit sync cursor | 61 | 0 / 0 | 0 / 0 | 1 | 60 |
| No retained class signature | 288 | 0 / 0 | 0 / 0 | 230 | 58 |
| Unique total | 406 | 0 / 0 | 0 / 0 | 266 | 140 |

Restart inputs mean repeated startup for one actor or an explicit resume/reload.
An aborted turn does not prove Escape. Repeated cursor inputs do not prove a
cursor defect. There were no retained explicit PID-reuse, pane-loss, or Escape
key inputs. Per-trace stale-binding classification is unavailable. These zeros
and missing labels do not mean those incidents did not occur.

The 266 argument failures occur at `tool.call`. The 140 setup failures occur
before any world input. Zero observed violations in these short prefixes is
not a property pass for the original histories.

## Synthetic fixtures and generated variants

Each class includes one fixture. The generated column counts its additional
variants. Violation counts include stopped prefixes and count monitor verdicts,
so one history can contribute to more than one property.

| Incident class | Generated | Total | Baseline completed / stopped | Baseline violations | v3.1 completed / stopped | v3.1 violations |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| Bound Pi dead, shell alive | 47 | 48 | 48 / 0 | P4: 48 | 48 / 0 | 0 |
| Worker never starts | 32 | 33 | 33 / 0 | P5: 33; E5: 33 | 33 / 0 | 0 |
| PID reuse | 59 | 60 | 60 / 0 | P4: 60 | 0 / 60 | 0 |
| Cursor replay | 28 | 29 | 29 / 0 | 0 | 29 / 0 | 0 |
| Escape | 34 | 35 | 35 / 0 | 0 | 35 / 0 | 0 |
| Clock gap | 0 | 1 | 0 / 1 | 0 | 0 / 1 | 0 |
| Pane loss | 0 | 1 | 0 / 1 | 0 | 0 / 1 | 0 |
| Restart | 0 | 1 | 0 / 1 | 0 | 0 / 1 | 0 |
| Shutdown/resume | 0 | 1 | 0 / 1 | P5: 1 | 0 / 1 | P5: 1 |
| Stale binding | 0 | 1 | 0 / 1 | 0 | 0 / 1 | 0 |
| Total | 200 | 210 | 205 / 5 | P4: 108; P5: 34; E5: 33 | 145 / 65 | P5: 1 |

Completed baseline runs contributed P4: 108, P5: 33, and E5: 33.
Completed v3.1 runs had no observed violations. The remaining P5 finding on both
targets came from the stopped shutdown/resume prefix. The monitor counts an
OS-origin pane closure without a preceding stop call. This preserves the
existing monitor finding; it does not resolve the cleanup-policy question.

The 60 v3.1 PID-reuse runs stopped during recovery. `WorldReplay.addActor`
checks whether the old PID exists. The recycled PID belongs to another process,
so the runner rejects replacement as an already-loaded actor. These are harness
stops, not evidence that v3.1 passes PID reuse.

## Unsupported inputs and stops

Counts include all 616 attempts per target. The list distinguishes model gaps,
historical input incompatibility, and the selected bound.

| Input or boundary | Stop | Baseline | v3.1 |
| --- | --- | ---: | ---: |
| `setup.teams` | Pre-existing Team setup needs public-tool bootstrap. | 140 | 140 |
| Historical `tool.call` arguments | Redacted or historical arguments fail the live schema. | 266 | 266 |
| Long-gap `tool.call` | Replay bound exceeded. | 1 | 1 |
| `os.kill` after pane closure | Target process is absent. | 1 | 1 |
| `tool.call` during restart | The bd fake does not model `show`. | 1 | 1 |
| `pi.start` after reboot | The retained lead actor is no longer live. | 1 | 1 |
| `pi.fork` | Cross-Session fork allocation is not modeled. | 1 | 1 |
| Recovery after `os.pidReuse` | PID-only actor check rejects replacement. | 0 | 60 |
| Total stopped | | 411 | 471 |

No unsupported operation was skipped or counted as successful. The first stop
ends that replay. Later unsupported steps may remain undiscovered.

## Monitor coverage limits

All histories received P1–P10, E1–E5, and S1–S6 verdicts.

- P1 was applicable to 210 v3.1 histories and passed. It was unavailable on
  baseline. P6 passed in 180 histories on each target.
- P4: baseline 70 pass, 108 violation, 438 unavailable; v3.1 180 pass and
  436 unavailable. P5: baseline one pass, 34 violations, 581 unavailable;
  v3.1 one pass, one violation, 614 unavailable.
- P9 passed in 122 v3.1 histories. It was unavailable in the remaining 494
  and in all baseline histories. P8 lacked journal sequence evidence.
- E5: baseline 147 pass, 33 violations, 436 unavailable; v3.1 180 pass and
  436 unavailable. Prefix passes do not establish whole-trace liveness.
- P2, P3, P7, P8, P10, and E1–E4 were unavailable in every run on both
  targets. Missing inputs include gone claims, deadlines, writing-call origins,
  journal sequence fields, and exact journal process generations. C2 inclusion
  alone did not make P10 evaluable.
- S1 had 60 witnesses on each target, but all v3.1 witnesses were on stopped
  PID-reuse prefixes. S2 had 48 baseline witnesses and no v3.1 witness.
  S3 and S4 had no witnesses. S5 and S6 were unavailable throughout.

Missing inputs, absent witnesses, and stopped prefixes prevent a full P/M/E
conformance claim. The completed dead-Pi and never-start cases support only
their bounded, synthetic comparisons.

## Private artifacts and verification

Per-trace receipts, verdicts, stop details, input digests, paired-input checks,
and the aggregate projection stay under `~/.pi/ptb-sim-corpus/results/`.
The directory also holds the transient driver and configuration for reproduction.
No empirical trace, name, text, coordinate, or trace id is committed here.

The driver loads the selected worktree's real `SimWorld` and `WorldReplay`.
It uses the common monitor source from the integration checkout. Both full
Vitest invocations passed collection. Pairwise checks verified 616 matching
input coordinates and scheduler seeds, and exactly 21 verdicts per run.
These collection checks do not convert property findings into passes.

Only this aggregate summary is committed. Production and simulator sources
stayed unchanged. The baseline worktree stayed read-only. No provider or real
Herdr process ran. To repeat, restore the private driver/configuration into the
designated checkout's `sim/` directory and use the pinned source revisions:

```sh
PI_REPLAY_TARGET=baseline npx vitest run --config sim/private-replay.local.config.ts
PI_REPLAY_TARGET=v3.1 npx vitest run --config sim/private-replay.local.config.ts
```

## D6=A follow-up: shape-preserving extraction and assumed Team setup

This experiment supersedes the completion counts above. The earlier experiment
remains a record of its own inputs and runner.

Both targets used common runner `sim-c1/6`, the same monitor source, and the
same 617 input/seed pairs. Production targets were baseline `2a56ea9` and
v3.1 `e413866`. The latter contains integration `0457658` and the exact-generation
replay fix. The baseline checkout stayed read-only.

The fresh live extraction produced 407 traces and 49,267 inputs. The earlier
snapshot had 406 traces. Incident labels now come from the private per-trace
manifest, including diagnostic evidence. This corrects the earlier report's
loss of labels that could not be recovered from reduced world inputs.

Changes in this experiment:

- Preserve public argument keys, JSON types, string lengths, array cardinalities,
  repeated-value joins, and Task/graph version grammar with synthetic values.
  Unknown dictionary keys remain redacted. Different aliases remain distinct.
- Synthesize an assumed Team through the selected production authorities.
  The resulting Team, Membership, Session, and runtime records agree. Setup
  tool calls/results are excluded from monitor input. Initial durable and
  process facts remain. The trace receives no invented model actions.
- Keep historical tool names, schemas, model-role literals, and Task versions.
  Do not translate them into successful current operations. No initial Task
  graph is restored. Completion means all inputs ran; it does not imply that
  every call succeeded or that the original real-world outcome was reproduced.
- Reuse the 200 generated cases, ten fixtures, seeds, and bounds from the first
  campaign. This includes all 60 PID-reuse cases. The bound remains 10,000
  operations and one virtual hour after setup.

### Completed and stopped runs

| Cohort | Inputs | Baseline complete / stopped | v3.1 complete / stopped |
| --- | ---: | ---: | ---: |
| Empirical | 407 | 34 / 373 | 34 / 373 |
| Hand-written synthetic | 10 | 6 / 4 | 6 / 4 |
| Generated synthetic | 200 | 200 / 0 | 200 / 0 |
| Total | 617 | 240 / 377 | 240 / 377 |

All 140 empirical traces with assumed Team setup passed bootstrap. They later
stopped on other gaps. The 34 completed empirical traces contain creation inputs.

Empirical classes overlap. Counts below use observed/candidate evidence from
the extractor. Neither an abort nor a diagnostic candidate proves an OS/UI act.

| Empirical class | Inputs | Baseline complete / stopped | v3.1 complete / stopped | Raw v3.1 findings |
| --- | ---: | ---: | ---: | --- |
| Restart observed | 22 | 0 / 22 | 0 / 22 | none |
| Abort/Escape candidate | 88 | 3 / 85 | 3 / 85 | P8: 1 |
| Cursor replay observed | 61 | 0 / 61 | 0 / 61 | none |
| Stale binding candidate | 48 | 0 / 48 | 0 / 48 | none |
| Pane loss candidate | 1 | 0 / 1 | 0 / 1 | none |
| Unclassified | 255 | 31 / 224 | 31 / 224 | P8: 1 |

No empirical baseline property violation was reported. No empirical trace had
explicit PID reuse or Escape input evidence in this extraction.

| Synthetic class | Inputs | Baseline complete / stopped | v3.1 complete / stopped | Baseline violations | v3.1 violations |
| --- | ---: | ---: | ---: | --- | --- |
| Bound Pi dead | 48 | 48 / 0 | 48 / 0 | P4: 48 | none |
| Never starts | 33 | 33 / 0 | 33 / 0 | P5: 33; E5: 33 | none |
| PID reuse | 60 | 60 / 0 | 60 / 0 | P4: 60 | none |
| Cursor replay | 29 | 29 / 0 | 29 / 0 | none | none |
| Escape | 35 | 35 / 0 | 35 / 0 | none | none |
| Clock gap | 1 | 0 / 1 | 0 / 1 | none | none |
| Pane loss | 1 | 0 / 1 | 0 / 1 | none | none |
| Restart | 1 | 0 / 1 | 0 / 1 | none | none |
| Shutdown/resume | 1 | 1 / 0 | 1 / 0 | none | none |
| Stale binding | 1 | 0 / 1 | 0 / 1 | none | none |

### Remaining unsupported inputs and bounds

Counts name the first stop in each run. Later gaps remain unmeasured.

| Stop class | Baseline | v3.1 |
| --- | ---: | ---: |
| Unregistered historical tools | 219 | 219 |
| Missing actor at an observed input | 85 | 85 |
| Current argument-schema rejection | 57 | 57 |
| Replay time/operation bound | 10 | 12 |
| Entropy tape exhausted | 3 | 0 |
| Scheduler drain bound | 0 | 1 |
| Absent process target | 1 | 1 |
| Unmodeled Beads command | 1 | 1 |
| Cross-Session fork | 1 | 1 |

Historical tools include `task_create`, `worker_ensure`, `spawn_teammate`,
`check_teammate`, and `task_list`. The 57 schema stops comprise
`task_graph_apply` 32, `team_sync` 15, `ensure_worker` 4, `alert_send` 3,
and one each for `task_update`, `team_shutdown`, and `task_read`.
The report does not claim that every schema rejection is source-only.
The shape tests independently check current valid examples.
Missing actors can follow unobserved launch history or a refused synthetic
model-role selection. They do not establish a production liveness defect.

The four stopped fixtures cover a long clock gap, an absent pane process,
an unmodeled Beads command, and an unsupported fork. Setup refusal and the
previous PID-only actor guard no longer stop this campaign.

### Are the v3.1 findings real?

The two raw P8 findings are suspected monitor false positives. Both completed empirical
runs published the allegedly omitted Task on the stamped branch page. The
page used `task_changes[].task_id` and `current.id/version`. P8's `pageNames`
reads `taskChanges` with `id/taskId`; its Task-version reader also omits the
public snake-case collection. Thus the monitor cannot see the published card.

The private diagnostic reruns preserve both branch pages and journal evidence.
An independent synthetic check in `sim/setup.test.ts` creates a Task, requests
updates, and matches the published card and version to the journal event under
the page's covered cursor. This checks the public production result without
using P8's parser. Task `p8-wire-shape` owns the monitor correction and its
verification. This change does not edit the monitor. Raw campaign verdicts
remain unchanged.

There is **no confirmed v3.1 production violation in this campaign**. This is
not a conformance claim: most empirical traces still stop, Task-version literals
are synthetic, and not-applicable monitors remain unavailable. The 60 completed
PID-reuse cases provide a bounded synthetic comparison: baseline P4 fails 60;
v3.1 reports no property violation.

### Evidence and reproduction

Private results, diagnostic histories, paired-input verification, and the driver
are under `~/.pi/ptb-sim-corpus/results/shape-setup/`. The driver imports one
common simulator and selects baseline production with `sourceRoot`. It uses all
21 monitors. Paired checks verified 617 matching input ids, source digests, and
seeds, plus 21 verdicts per input. Both campaign collection invocations passed.
The diagnostic driver option selects the two P8 cases without overwriting the
full summaries. Per-trace files remain private.

Use `node sim/extract/run.mjs` for new extraction. Shared schema imports now
include ESM-only dependencies, so the old `ts-node` CommonJS entry is unsuitable.
The CLI loader check, 17 focused extraction/setup/PID tests, and typecheck
passed. `npm test` passed 1,986 tests; three were skipped. Architecture impact:
none on production contracts or topology.
