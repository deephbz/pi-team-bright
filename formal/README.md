# Bounded formal checks

These TLA+ models check bounded safety arguments for Task-first hardening.
`SyncPresentation` also checks conditional wait termination. TLC
explores every reachable state in each stated finite instance. The models do
not prove that TypeScript refines them. Deterministic code traces and runtime
checks are separate evidence.

Run from the package root:

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar bash scripts/formal-check.sh
```

CI fetches the [official release artifact](https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar).
The runner requires jar SHA-256
`ab4694601923fd5ac06452abbf847c366a5054a3d739552085edd6ed986c29ec`.
It fails if Java or that exact jar is absent. It downloads nothing. Set
`FORMAL_RESULTS_DIR` to an absolute or relative directory to retain full TLC
logs, states, and counterexamples. Otherwise, the runner creates a temporary
directory and prints its path. The pinned jar reports
`TLC2 Version 2026.09.25.163503 (rev: 8f4bc8b)` at runtime. That observed
string differs from the release URL's `v1.8.0` label, so this record identifies
the jar by checksum and observed runtime string.

## Models and source boundaries

| Model | Finite instance and safety claim | Source boundary |
| --- | --- | --- |
| `GraphAttempt` | A→B success dependency; one semantic A revision; four bounded A Attempt labels; B failure requests at most two repairs. A running or achieved B uses the currently accepted A Attempt (`AcceptedLineage`). Repair traversals stay within two (`RepairBound`). | `src/task-authority/graph-control.ts`: semantic lineage and reverse closure in `applyGraph`; failure-edge traversal and supersession in `complete`; prerequisite Attempt capture and activation key in `derive`. |
| `MembershipFence` | One Worker; two opaque Membership labels; two opaque Session labels; one held lease; at most two writes. A held lease matches the exact current pair (`LeaseExact`). A write cannot cross replacement (`NoStaleWrite`). | `src/utils/teams.ts`: `withCurrentSessionBinding` holds the exact Membership mutation lease, checks current Session binding, and runs the write inside the lease. |
| `PublicationObservation` | Two changed Task coordinates and two authority commits. Retirement fence, Task events, delivery queue, and staged observation cursor are independent state. It includes retirement failure, crash/reopen, current exact replay, superseded retry, and complete or partial Task reads. Published events follow a commit; delivery uses current authority at its check point; a successful current replay has a Task event; a superseded retry does not attempt old retirement; staging follows a complete read. | `src/task-authority/graph-orchestration.ts`: authority mutation, retirement, publication warnings, and current-coordinate replay query; `src/utils/graph-revision-retirement.ts`: current coordinates read from committed graph authority; `src/utils/task-delivery.ts`: currentness checks; `src/coordination/observation-service.ts`: complete projection before page-cursor staging. |
| `SyncPresentation` | Contract revision 2: one exact leader Session, two turns, four result labels, native or framework initial staging, and all subsets of active/pending/runtime-unknown/delivery-unknown Worker evidence. Successful message end resolves the captured pending candidate before tools run. A later candidate survives. Parallel and sequential duplicates refuse; the same call replays. C4 distinguishes `unsettled` from `caught_up`. C8 traverses up to two empty or visible pages. Pending conflicts and empty updates are wasted results. | `extensions/index.ts`: provider request, assistant message end, and turn end hooks; `src/coordination/observation-service.ts`: staging, acknowledgement, and concurrent observation; `src/utils/sync-liveness.ts`: Worker evidence. |

The Graph Attempt labels start at 1. Zero means no B input. Revision numbers
and labels are finite model coordinates. They do not define ordering or global
uniqueness for production `TaskVersionRef` or `GraphVersionRef`. Those tokens
are opaque equality coordinates. A graph revision can leave an unchanged Task
projection token unchanged. The publication model deliberately treats both
revisions as changed coordinates.

## Checked results

The checked source bundle uses the four `.tla` files, their `.cfg` files,
and `scripts/formal-check.sh`. The first three models completed through the
runner on 2026-09-26 with the pinned jar. Each passing search ended with an empty queue. “Depth” is TLC's
reported complete state-graph depth for a passing instance. Fault and witness
runs stop at the first counterexample, so their state counts are partial.

| Instance | Generated / distinct | Depth | Result |
| --- | ---: | ---: | --- |
| `GraphAttempt` | 53 / 36 | 16 | Complete; no invariant error |
| `MembershipFence` | 81 / 24 | 6 | Complete; no invariant error |
| `PublicationObservation` | 23,825 / 6,267 | 14 | Complete; no invariant error |
| `SyncPresentation` (2026-10-07; jar SHA `7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d`; TLC `2026.10.06.014338`, rev `94d0c50`) | 418,304 / 140,380 | 18 | Revision 2 complete; no invariant or temporal property error |

The revision-2 `SyncPresentation` runs used the current official release artifact
with the runner's flags. The rolling `v1.8.0` asset no longer
matches the pinned checksum. The runner still rejects it with exit 2. The pin
stays unchanged. These results do not claim a pinned-jar runner pass. A temporary
runner copy outside the repository changed only `expected_sha` to the downloaded
artifact's checksum. It passed all 22 cases, including the seven sync cases.
Its full logs and traces are in `/tmp/ptb-sync-formal-rev2-final/`. The summary
is `/tmp/ptb-sync-formal-rev2-final.log`.

To reproduce the passing instance with that verified artifact:

```sh
java -XX:+UseParallelGC -cp /tmp/tla2tools.jar tlc2.TLC \
  -deadlock -noGenerateSpecTE -metadir /tmp/sync-presentation-states \
  -config formal/SyncPresentation.cfg formal/SyncPresentation.tla
```

Use each mutant config below with the same command to reproduce its trace.

The fault configurations replace one guard or outcome. They reached these
specific counterexamples:

| Fault | Counterexample action sequence | Expected invariant |
| --- | --- | --- |
| `GraphAttempt.mutant` | Claim A → achieve A → claim B → change A meaning while B stays active | `AcceptedLineage` |
| `GraphAttempt.repair-bound` | Three B failures each request repair | `RepairBound`, not `TypeOK` |
| `MembershipFence.mutant` | Acquire exact pair → replace its Membership during the lease | `LeaseExact` |
| `MembershipFence.stale-write` | Acquire → replace → write through the old lease | `NoStaleWrite` |
| `PublicationObservation.early-publication` | Publish before authority commit | `CommitBeforePublication` |
| `PublicationObservation.partial-observation` | Read partially → stage its cursor | `CompleteBeforeAdvance` |
| `PublicationObservation.trust-fence` | Commit 1 → queue old delivery → commit 2 → retirement fails → deliver via absent/stale fence | `CurrentDeliveryOnly` |
| `PublicationObservation.skip-replay` | Commit current coordinate → claim successful replay without its Task event | `TruthfulReplay` |
| `PublicationObservation.retry-retirement` | Commit 1 → commit 2 → retry operation 1 and attempt old retirement | `NoStaleRetirement` |
| `SyncPresentation.ack-turn-end` | Staged result → provider request includes result → completed assistant message → next sync conflicts with presented pending result | `NoWastedSyncAfterPresentation` |
| `SyncPresentation.keep-pending` | Staged result → provider request includes result → completed assistant message → acknowledgement fails and keeps pending | `NoStuckPending` |
| `SyncPresentation.immediate-pending` | Provider request → completed assistant message → sync starts with actuation pending → return before any recheck | `LivenessOutcomeC4` |
| `SyncPresentation.discard-only-ack-false` | Staged result → provider request has no proof → successful message end leaves the captured candidate pending | `NoStuckPendingWithoutProof` |
| `SyncPresentation.sequential-duplicate` | Provider request → completed assistant message → first sync stages `caught_up` → sequential second call reports a pending conflict | `SequentialRefusal` |
| `SyncPresentation.native-empty-page` | Provider request → completed assistant message → sync reads an empty native page → returns empty updates | `NoEmptyUpdates` |

All six sync mutant runs used the same jar SHA and TLC version as the passing
revision-2 instance. All exited with code 12. Their searches are partial.

| Sync mutant | Generated / distinct | Depth |
| --- | ---: | ---: |
| `ack-turn-end` | 12,525 / 7,202 | 4 |
| `keep-pending` | 2,863 / 2,703 | 3 |
| `immediate-pending` | 25,365 / 13,384 | 5 |
| `discard-only-ack-false` | 2,867 / 2,707 | 3 |
| `sequential-duplicate` | 38,218 / 19,728 | 6 |
| `native-empty-page` | 24,039 / 12,510 | 5 |

Two deliberately false reachability probes also produced witnesses under the
fault-free rules. `GraphAttempt.interleave` reached repair followed by semantic
revision. `PublicationObservation.crash-replay` reached commit → crash → reopen
→ current replay repair. `PublicationObservation.retirement-gap` reached commit
→ retirement failure with the fence behind authority. These probes establish
action reachability in this finite instance; their named predicates are not
product safety requirements.

## Claim limits

The first three models make no fairness assumption or liveness claim. TLC
deadlock checking is disabled because terminal states are valid. A blocked
Task can wait indefinitely. The repair budget is a cap, not a guarantee that
repair starts or succeeds.

`SyncPresentation` uses weak fairness of local `Next` scheduling. Worker evidence
can resolve during a wait, and resolution restarts the quiet interval. A journal
change can end the wait. The finite abstraction permits only removal of Worker
evidence during each wait. It does not model repeated evidence churn. Under
these limits, a wait without an active Worker eventually returns. A wait-zero
call also eventually returns. An active Worker with a positive wait can block
indefinitely. No fairness assumption requires that Worker to settle.

The sync model treats evidence classes as abstract Workers. It checks reason
sets, not Worker names or multiplicity. Proof is valid, absent, or rejected.
Acknowledgement succeeds, returns false, or throws. A discard leaves committed
observation unchanged. The invariant protects a candidate staged after the
request. Label 4 represents one such late candidate; the model does not replace
that label again. Other result labels represent the initial result and the two
native turns. A successful acknowledgement adds the presented result label to
the committed observation set.

The model covers empty-page traversal and visible-page return. It excludes
cursor arithmetic, partial Task reads, exact branch/payload matching, storage
failures outside acknowledgement, real clocks, cancellation while waiting,
binding changes, historical decoding, and arbitrary turn counts. Error and
abort paths retain pending without presentation. Framework retry/discard
behavior needs a runtime check. Supported composition assumes that no later
extension removes the staged result from the provider payload or replaces the
completed message. Code and real Pi checks must establish refinement and exact
payload identity. Architecture impact: none.

The graph model fixes one valid two-Task shape. It excludes arbitrary DAGs,
cancellation, Worker occupation, operation replay, arbitrary failure targets,
malformed keys, and JavaScript object behavior. The finite string abstraction
cannot detect special keys such as `__proto__`; code tests cover that risk.

The Membership model abstracts lease serialization and exact equality. It
excludes filesystem failures, multi-Team discovery, process identity, launch
capabilities, and lock implementation. The labels carry no ordering.

The publication model checks delivery eligibility only at the current read
point. It does not revoke an external effect already sent. It does not make
commit, retirement, publication, and delivery atomic. A failed retirement can
leave a stale fence while committed authority is newer. A current exact replay
can repair a missing Task event or report a degraded outcome; no invariant
requires it to happen eventually. A superseded historical event can remain
missing. The model does not prove event uniqueness under concurrent replay;
delivery and event publication remain at least once. Its observation action
only stages one complete page. A later Pi branch-state commit, multiple pages,
and concurrent authority changes during a read need separate evidence.

`NoStaleRetirement` checks the replay action guard through a model flag. It
does not inspect a real retirement store or warning. The independent
`test/formal-adversarial/publication-window.test.ts` trace checks the caller's
warning and fence outcome for a stale operation retry.
