# Bounded formal checks

These TLA+ models check three safety arguments for Task-first hardening. TLC
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

The Graph Attempt labels start at 1. Zero means no B input. Revision numbers
and labels are finite model coordinates. They do not define ordering or global
uniqueness for production `TaskVersionRef` or `GraphVersionRef`. Those tokens
are opaque equality coordinates. A graph revision can leave an unchanged Task
projection token unchanged. The publication model deliberately treats both
revisions as changed coordinates.

## Checked results

The checked source bundle uses the three `.tla` files, their `.cfg` files,
and `scripts/formal-check.sh`. The runner completed on 2026-09-26 with the
pinned jar. Each passing search ended with an empty queue. “Depth” is TLC's
reported complete state-graph depth for a passing instance. Fault and witness
runs stop at the first counterexample, so their state counts are partial.

| Instance | Generated / distinct | Depth | Result |
| --- | ---: | ---: | --- |
| `GraphAttempt` | 53 / 36 | 16 | Complete; no invariant error |
| `MembershipFence` | 81 / 24 | 6 | Complete; no invariant error |
| `PublicationObservation` | 23,825 / 6,267 | 14 | Complete; no invariant error |

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

Two deliberately false reachability probes also produced witnesses under the
fault-free rules. `GraphAttempt.interleave` reached repair followed by semantic
revision. `PublicationObservation.crash-replay` reached commit → crash → reopen
→ current replay repair. `PublicationObservation.retirement-gap` reached commit
→ retirement failure with the fence behind authority. These probes establish
action reachability in this finite instance; their named predicates are not
product safety requirements.

## Claim limits

No fairness assumption is made. TLC deadlock checking is disabled because
terminal states are valid. These checks make no liveness claim. A blocked
Task can wait indefinitely. The repair budget is a cap, not a guarantee that
repair starts or succeeds.

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
