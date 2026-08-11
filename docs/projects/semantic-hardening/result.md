# Semantic hardening result

Date: 2026-08-11
Stage: consolidation and hardening
Result revision: `5950f3b3f17124b9baf38afa48d839dc503d847b`
Trio baseline: `c54dc25b34770b70afedffc7e87728da6376ee0f`
Membership baseline: `6997dce`
Integration base: `7453ce1b2a2ca49f8729a6bf399f7c1f25bfca6a`
Package baseline: `@hypercarrier/pi-team-bright@0.17.0-rc.10`
Verified source candidate: `638d5934bd52c7f4a3fe18525e5d72569a227211`
Package metadata: `@hypercarrier/pi-team-bright@0.17.0-rc.11`
Publication state: untagged and unpublished
Public behavior: unchanged
Architecture impact: changed internally; HyperCarrier's diagram is unchanged
because it keeps Pi Team Bright internals opaque

## Result

The Project produced an evidence-backed internal hardening series without a
public tool, schema, package-export, persisted-record, filename, retry, timing,
or default-behavior change. Accepted commits `69c30acf5db23be8f656b2a6821b0ea032ae04cb` and
`5950f3b3f17124b9baf38afa48d839dc503d847b` complete the accepted Trio and
additive Membership projection boundaries. The latter splits its private reader
from the unchanged public projection. Team/Task reverse dependencies and the
proposed Coordination worker-run query remain target gates. The Project also characterized the main Task-delivery causal path,
made two Task dependency seams explicit, moved durable lead discovery to Team
authority, removed duplicate result validation, replaced nondeterministic lock
test oracles, and added a reproducible Task-hydration benchmark.

The maintained [subsystem audit](subsystem-boundary-audit.md) and machine
[dependency map](subsystem-dependency-map.json) record the current and target
source directions. Exact behavior remains authoritative in code and tests. This
report records the outcome, evidence, optimization choices, and limits.

## Commit series

The ten Project commits after the rc.10 integration base are:

1. `fe0cfa7` — outside-in Task-delivery characterization.
2. `2635b79` — Coordination inventory and Alert failure characterization.
3. `da1ca50` — Task contracts and injected reconciliation query.
4. `2bbb494` — duplicate result-validation removal.
5. `34eb5b9` — Team-owned durable lead-Session discovery.
6. `6f47ae6` — deterministic local lock-contention oracles.
7. `9a41d24` — payload-free Task-hydration benchmark.
8. `734bbd3` — characterization alignment with rc.10 behavior.
9. `8f2da7c` — rc.10 subsystem audit refresh.
10. `15e707b` — consumer-owned Task mutation-publication port and durable
    composition adapter.

The original rc.8 publication patch stash became obsolete after the reviewed
rc.10 implementation entered `15e707b`. It was removed; no Project stash
remains.

## Delivered evidence and boundaries

The registered-extension characterization covers assigned Task creation, exact
Session presentation, context observation, successful-turn acknowledgement,
leader synchronization, cancellation, replay, same-Session restart, stale
Membership replacement, and delivery recovery. The main executable anchor is
[`causal-path-characterization.test.ts`](../../../src/utils/causal-path-characterization.test.ts).
Branch-lineage behavior and Alert publication failure have separate evidence in
[`causal-path-characterization.test.ts`](../../../src/utils/causal-path-characterization.test.ts)
and
[`alert-publication-failure.characterization.test.ts`](../../../src/utils/alert-publication-failure.characterization.test.ts).
The [behavior inventory](behavior-inventory.json) retains proof limits and owner
classification state.

Task update and journal contracts plus `TaskReconciliationQuery` moved to Task
ownership. The injected Beads query removed the dynamic reconciliation cycle;
[`reconciliation-equivalence.test.ts`](../../../src/task-authority/reconciliation-equivalence.test.ts)
protects suppression, external-change delivery, owner-marker recovery,
deduplication, replay, and metadata-gap refusal.

Task mutation now consumes a consumer-owned publication port. The stateless
[`durable-task-mutation-publication.ts`](../../../src/adapters/durable-task-mutation-publication.ts)
implements concrete Coordination, failed-hint, and Task-delivery calls outside
Task authority. Deterministic order, failure continuation, warning, import
fence, read-only default, no-op, and replay evidence lives in
[`durable-task-mutation-publication.test.ts`](../../../src/adapters/durable-task-mutation-publication.test.ts)
and
[`task-mutation-publication-order.test.ts`](../../../src/model-tool-contract/task-mutation-publication-order.test.ts).
The canonical non-self-referential source/test receipt covers 16 paths with
SHA-256 digest
`d6da537790c95ac42ef741c5aa2f1fdf6999966ac76c525190838b01d8f96219`.

The accepted Task read boundary gives `TaskAuthorityReadPort<T>` and distinct
`TaskAuthorityReadTeamPort` canonical homes in
[`contracts.ts`](../../../src/task-authority/contracts.ts#L21). External durable
read adapters and explicit read-only or publishing factories replace raw/default
read paths. `BeadsTaskAdapter` has no default authority constructor. Independent
acceptance passed its selected 28-file/207-test sweep, typecheck, lane closure,
QA, package, public, and fence checks. No aggregate ran.

Independent re-verification accepts `TaskChangeDelivery` behind its required
consumer-owned `TaskDeliveryMembershipPort` ([`task-delivery.ts`](../../../src/utils/task-delivery.ts#L139)). The external durable adapter resolves the active exact recipient and holds both send and acknowledgement leases
([`durable-task-change-delivery-membership.ts`](../../../src/adapters/durable-task-change-delivery-membership.ts#L5)). Composition injects it into the Pi Session adapter
([`extensions/index.ts`](../../../extensions/index.ts#L345); [`pi-team-session-adapter.ts`](../../../extensions/pi-team-session-adapter.ts#L286)). The focused characterization preserves stale-target refusal, send/context-stage/acknowledgement order, replacement refusal, failed-send replay, and one acknowledgement. Stopped migration is not part of this boundary.

Independent verification also accepts `PiSessionTeamQueryPort` and
`CoordinationHiddenObservationPort`. The former moves Pi Session adapter Team
queries behind its Team-owned read-only contract and external durable adapter.
The latter moves hidden-observation projection reads and commits behind a
Coordination-owned port and external durable adapter. Composition injects both.
This closes those two target seams, but TeamConfig's mixed registry, Task/Team
reverse dependencies, and Coordination runtime, event, and nudge-actuation
seams remain open.

These checks prove deterministic local source and harness behavior. They do not
prove a real Pi process, Beads/Dolt contention, external writers, watcher
delivery, OS scheduling, or terminal pixels. No aggregate ran.

Durable lead-Session discovery moved verbatim from Pi composition to Team
authority. Focused Team and Session tests plus an AST body comparison preserve
missing, exact-match, newest-active, malformed-record, ambiguity, environment,
and lifecycle behavior.

Accepted source commit `b4bf6dee91cf25532cbc33a397167567ba6d347e`
(`refactor: isolate Coordination nudge boundary`) gives Coordination ownership of debt
meaning, exact debt identity, event pagination, Task-projection revision, and
failed-hint provenance. Durable Coordination adapters retain JSONL reservation
and promotion storage. `SyncNudgeConductor` owns timers only. Pi alone
revalidates exact Team epoch, lead Membership, Session, and full branch; it
reserves, sends the unchanged custom message, proves that exact persisted
message, and promotes the record. When logical Workers exist, missing optional
policy version remains eligible with its legacy undefined interpolation. The
nudge-specific outer binding avoids an early `none` or no-active-Team result,
but its durable hidden-observation read still applies `teamModelToolContractGap`.
Absent logical Workers therefore returns the exact legacy unavailable result.
Snapshot and update observation also require logical Workers. The next
structural seam is the combined Trio façade and fake. A separately reproduced
baseline terminal-admission defect is the next own-commit issue, not a nudge
regression.

## Terminal-refusal correction

Test-hardening commit `3b265ea6fbdc53c9b753950a4ed01ccddad527d8`
changed the registered Pi Session characterization to use canonical Alert
delivery. It exposed a pre-existing resumed-session shutdown defect. Intentional
behavior-fix commit `cafdf2deb4ccdbb47cb40b87e83081d1c9128665` corrects that
case: a resumed foreign or nested Worker or lead Session remains alive and
unbound after terminal-placement refusal. Launch and runtime admission refusals
that set `exitProcess=true` still shut down.

The exact checks are the “keeps a resumed Worker alive when foreign placement
refuses its Team binding” and “keeps a resumed lead alive when foreign placement
refuses its Team binding” cases in
[`pi-session-adapter.characterization.test.ts`](../../../src/utils/pi-session-adapter.characterization.test.ts),
and the nested-Worker and foreign-lead refusal cases in
[`terminal-backend.contract.test.ts`](../../../src/utils/terminal-backend.contract.test.ts).
Any result from the original checkout is invalid for this correction. The tests
are deterministic one-process hook evidence. They do not prove a real Pi
process, terminal, or terminal carrier.

No public tool, schema, package export, persistence shape, or source-graph
coordinate changed. The accepted graph remains 99 production TypeScript files
and 334 static local edges. Architecture impact is **none** for this correction.
No aggregate ran. The next structural boundary remains the combined Trio façade
and separate fake.

## Accepted Trio split

`ModelToolJourneyPort` is a thin Trio facade over neutral Team, Task, Alert, and
Coordination application contracts. Durable ownership is explicit in
`durable-model-tool-team-application.ts`,
`durable-model-tool-task-application.ts`,
`durable-model-tool-alert-application.ts`, and
`durable-model-tool-coordination-application.ts`; bindings remain separate in
`durable-model-tool-bindings.ts`. `in-memory-state.ts` and
`in-memory-authority-ports.ts` hold opaque fake authority state, while existing
journey and legacy port paths are thin wrappers.

Task and Alert commits remain authoritative when later Coordination publication
fails. The failure is a partial outcome; it does not imply rollback. Nominal
implementation attempts rejected during design remain historical evidence.
Focused acceptance gates passed, but they prove deterministic local behavior
only. They do not prove real Pi persistence, external Beads/Dolt contention,
cross-process forks, native watcher delivery, OS scheduling, external writers,
or terminal pixels. The additive Membership boundary is now complete. The historical Trio graph is
111 production files and 426 local edges. The current canonical graph is 112
production files and 425 resolved static import/re-export edges, with zero
nontrivial SCC, self-cycle, or runtime dynamic relative import.

## Accepted Membership observation boundary

`5950f3b` makes
[`membership-observation-reader.ts`](../../../src/team-authority/membership-observation-reader.ts)
the only private Team/runtime filesystem decoder. Public
[`observation.ts`](../../../src/public/observation.ts) retains the exact
`pi-teams-observation/1` DTO, JSON Schema, export path, deadline, AbortSignal,
retry, ordering, diagnosis, mixed-record, and privacy behavior. The reader is
lock-free and read-only; it does not claim OS liveness or repair the separate
Beads/Dolt resource-contention risk.

The focused public observation and reader suites passed 22 tests. TypeScript,
package/export, generated-output, static-fence, and diff checks passed. The
CommonJS and TypeScript package probe retained
`@hypercarrier/pi-team-bright/observation`. Generated output adds the reader
closure and removes unreachable observation-only runtime, paths, lock, and
trace closure files. Core imports of the public projector remain zero.

This is an internal dependency-direction change only. It adds no public API,
persistence, authority, deployment, or HyperCarrier topology change. The
current structural claim remains limited to deterministic local evidence; it
does not prove OS process state, external writers, cross-process contention, or
terminal pixels.

## Optimization report

The Million Eyes review froze 193 source entries and 158 call-evidence files
across seven successful lenses. Its
[machine receipt](../../journal/artifacts/2026-08-09-million-eyes-code-quality-round-1-receipt.json)
and [raw results](../../journal/artifacts/2026-08-09-million-eyes-code-quality-round-1-results.json)
retain the review source and proof limits.

Accepted changes were narrow:

- Remove two duplicate validations from `assembleToolResult`; keep
  `projectToolResult` as the single validation and projection path. Focused
  tests and a 14-example baseline differential preserve exact valid results,
  validation order, and errors.
- Move lead discovery verbatim into Team authority rather than add a new service
  or storage contract.
- Replace random lock-test timing with controlled barriers and captured 5–15 ms
  retry schedules. Mutation probes detect lock bypass and the former 100 ms
  retry cadence; production locking did not change.
- Add `benchmark:task-hydration` as payload-free measurement infrastructure. It
  changes no production read path.
- Invert the two Task dependencies only after outside-in and focused equivalence
  gates existed.

The [performance receipt](../../journal/artifacts/2026-08-09-coordination-history-performance-probe.json)
measured a focused one-ID read at 425.2 ms p50 and a full 21-Task snapshot at
6,249.1 ms p50. A 22-ID native show measured 6,188.1 ms p50. One-ID reads with
reverse dependents had a 417.3 ms p50 and 3,852.2 ms p95, while reads without
dependents had a 387.0 ms p50 and 408.2 ms p95. These measurements identify a
Beads hydration tail; they do not prove that commit-history size alone causes
it.

Rejected changes would have changed behavior or lacked evidence:

- Removing reverse-dependent hydration would weaken opaque Task-version meaning.
- Filtering closed Tasks would change the current public snapshot.
- Raising the 10-second Beads timeout needs a separate timing decision.
- A shared Alert/Task delivery base class would hide different sequencing.
- Deleting apparently unreachable hydration code or unifying launcher argument
  paths was not justified by static evidence.
- Restoring the old rc.8 patch would bypass the reviewed rc.10 implementation.

Deferred work includes an equivalent cheaper authority query, actual Beads
contention reduction, full-history Team-event scan measurement, and immutable
Task-create operation identity. Each needs a separate behavior or measurement
gate. Membership observation, Alert ports, and Trio are complete; Team and Task
reverse dependencies plus the Coordination worker-run query remain structural
target gates.

## Equivalence, architecture, and limits

Independent focused evidence passed 113 tests plus typecheck, result QA, lane
closure at 88 test files (67 fast and 21 exhaustive), package verification,
public-surface comparison, persistence checks, and diff checks. The accepted nudge selection has 99 production TypeScript files and 334 unique
resolved static local edges, with no nontrivial SCC, self-cycle, or runtime
dynamic import. The [audit](subsystem-boundary-audit.md) owns detailed counts
and citations.

Exact rc.11 source `638d5934` then passed the one reserved Node 22.22.1 full
aggregate: 88 files and 695 tests in 253.59 seconds. Follow-up lane, package, QA,
public, persistence, JSON, link, privacy-range, and exact installed-tarball gates
passed. The [source verification
receipt](../../journal/2026-08-09-v0.17.0-rc.11-source-verification-receipt.md)
records the one-pack procedure, 93-file artifact sizes and digests, observation
and Beads canaries, Pi 0.84.1 load, privacy limitation, and publication boundary.

Public tools, schemas, package exports, agent projections, persistence shapes,
filenames, migration behavior, and supported historical records remain
unchanged. Internal source ownership changed for Task reconciliation, Task
publication, and Team lead discovery. These internals are opaque in the
canonical HyperCarrier view, so no diagram update is required.

This completes the Membership observation, Alert-port, and Trio boundaries, not
the remaining Team, Task, and Coordination target gates or all system proof.
ALERT-004 remains characterized and unclassified. Broad TRIO-004 parity, Alert restart and later-presentation
behavior, a real Pi subprocess/rendered-terminal receipt, and model
interpretation remain outside the proved scope.

The result bundle and rc.11 metadata are committed in verified source
`638d5934`. That source remains untagged and unpublished. No push, npm
publication, npm `next` change, registry comparison, provenance claim, GitHub
release, or published-release receipt occurred. Publication is a separate
authorized operation and must compare its external identities with this source
and receipt.

Current nudge evidence is deterministic and one-process. It does not prove real
Pi persistence, external Beads/Dolt contention, cross-process forks, native
watcher delivery, OS scheduling, concurrent external writers, or terminal
pixels. Do not require speculative completion of remaining boundaries, but do
not publish an unexplained regression or an unclassified behavior change.
