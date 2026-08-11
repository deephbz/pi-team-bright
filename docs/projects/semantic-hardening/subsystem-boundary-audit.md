# Accepted subsystem boundary audit

Date: 2026-08-11
Status: maintained semantic-hardening audit; accepted uncommitted Task read and
TaskChangeDelivery boundaries extend baseline
`cb38d9254dd0cccb9e745a8df3edb27f367d852d`. They add generic read and
exact-recipient delivery ports with external durable adapters and explicit
composition. `PiSessionTeamQueryPort` and `CoordinationHiddenObservationPort`
are independently verified. Remaining Team, Task, and Coordination target
violations stay open.
Reviewed baseline revision: `8f2da7c5c13ab11aebbdfa6f297219ddf5e4b571`
(`audit/semantic-hardening-behavior-inventory`), based on public rc.10 integration
revision `7453ce1b2a2ca49f8729a6bf399f7c1f25bfca6a`
Production TypeScript baseline: `e55b4f2a9190d700a03d95cb9dee75e5c892ca0a`
Implemented commit evidence: characterization `fe0cfa7`, test and audit
hardening `2635b79`, Task reconciliation boundary `da1ca50`, result-validation
cleanup `2bbb494`, Team lead-discovery ownership `34eb5b9`, deterministic lock
tests `6f47ae6`, Task-hydration benchmark `9a41d24`, rc.10 alignment `734bbd3`,
and rc.10 audit refresh `8f2da7c`
Independently verified non-self-referential Task publication source/test
selection: 16 paths with SHA-256 diff digest
`d6da537790c95ac42ef741c5aa2f1fdf6999966ac76c525190838b01d8f96219`
Upstream rc.9/rc.10 Coordination evidence: event hydration `a80f102`, exact
baselines `13d9805`, batch completeness `c2bc332`, page watermark `ca9581d`,
failed-event hints `3576fbc` and `6411d10`, default nudge policy `fd12921` and
`35574f4`, resumed-leader binding `0aa4d8e`, final Coordination blockers
`0687eb7`, and package-version compatibility decoupling `2ded422`
Architecture impact: **changed** for internal Task publication, Task
reconciliation, Team, and Coordination boundaries. HyperCarrier's canonical
diagram stays unchanged because it keeps Pi Team Bright internals opaque.

Terminal-refusal correction: test-hardening commit
`3b265ea6fbdc53c9b753950a4ed01ccddad527d8` corrected the Session
characterization to use canonical Alert delivery and exposed a pre-existing
resumed-session shutdown defect. Intentional behavior-fix commit
`cafdf2deb4ccdbb47cb40b87e83081d1c9128665` keeps resumed foreign or nested
Worker and lead Sessions alive and unbound after terminal-placement refusal;
launch or runtime refusals with `exitProcess=true` still shut down. The exact
anchors are the resumed-Worker and resumed-lead foreign-placement cases in
`src/utils/pi-session-adapter.characterization.test.ts`, and nested-Worker and
foreign-lead refusal cases in `src/utils/terminal-backend.contract.test.ts`.
Original-checkout results are invalid for this correction. The deterministic
one-process hook tests do not prove a real process, terminal, or terminal
carrier. No public/schema/persistence change occurred. The 99-file/334-edge
accepted graph is unchanged, and architecture impact is **none** for this
correction. The next boundary remains Trio.

## Accepted Trio boundary

The accepted named architecture uses `ModelToolJourneyPort` as a thin facade
above neutral Team, Task, Alert, and Coordination application contracts.
`durable-model-tool-team-application.ts`,
`durable-model-tool-task-application.ts`,
`durable-model-tool-alert-application.ts`, and
`durable-model-tool-coordination-application.ts` are the durable owners;
`durable-model-tool-bindings.ts` owns composition bindings. The in-memory split
uses opaque state and authority ports, not one shared fake store. Existing
journey and legacy port paths remain thin compatibility wrappers.

Task and Alert commits survive a later Coordination publication failure. The
public result records the partial outcome; it does not roll back authority state.
This preserves the existing partial-failure semantics. Rejected nominal
implementations remain historical evidence. Focused acceptance gates establish
deterministic local behavior only, not real Pi persistence, Beads/Dolt
contention, cross-process forks, native watchers, OS scheduling, external
writers, or terminal pixels.

The historical Trio graph is 111 production files and 426 resolved static
import/re-export edges. The current canonical AST graph is 112 production files
and 425 such edges, with zero nontrivial SCC, self-cycle, or runtime dynamic
relative import. Architecture impact remains internal only, so Structurizr stays
unchanged because Pi Team Bright internals remain opaque.

## Scope and evidence

This audit uses the five accepted subsystems in the Project handoff: Team
authority and Role realization, Task authority, Alert authority, Coordination
observation, and Trio-facing interface and projections. Public Membership
observation remains an additive machine projection of Team authority.

The initial review covered 60 production TypeScript files with 18,145 lines and
77 test or test-support files with 20,585 lines. The Pi Session adapter
selection from baseline `1686ac1` has 81 production TypeScript files with
19,693 lines and 94 test files with 25,207 lines; two test-support files add
596 lines. Production means current tracked or selected `.ts` files under
`src/` and `extensions/`, excluding `*.test.ts`; test support means
`test/setup.ts` and non-test `test/support/*.ts`, while runner-only global setup
is excluded. A TypeScript-AST scan resolves static relative import and re-export
specifiers between those production files. The earlier accepted Coordination nudge commit
`b4bf6dee91cf25532cbc33a397167567ba6d347e` had 99 production TypeScript files
and 334 unique resolved static local edges. The accepted Trio graph remains historical evidence. The current canonical
AST scan uses the same method: static relative TypeScript `import` and
re-export declarations resolved to selected production files, counted as
ordered declaration edges, with Tarjan SCC and literal runtime dynamic imports
separately scanned. It reports 112 files and 425 edges, with no nontrivial SCC,
self-cycle, or runtime dynamic import expression. The recomputed current graph
for the Task read selection has 115 production TypeScript files, 20,017 lines,
434 ordered import/re-export declaration edges (402 unique ordered file edges),
no nontrivial SCC, no self-cycle, and no literal relative runtime dynamic
import. The prior 87/285 Alert-port and
92/304 slice-B query counts remain historical evidence for earlier slices. The prior hidden dynamic Task-adapter cycle remains removed, and the
Task mutation path no longer imports concrete publication writers. Type-query
`import("...")` syntax is not a dynamic import expression.

The independently accepted uncommitted Pi Session selection has four paths:
`extensions/index.ts`, `extensions/pi-team-session-adapter.ts`,
`src/team-authority/team-session-lifecycle-service.boundary.test.ts`, and
`src/utils/pi-session-adapter.characterization.test.ts`. It passed 114 focused
tests, typecheck, 94 test lanes, package, agent-surface, static, and diff
checks. Its selection diff digest is
`f723a75a1defd74a897294993be513471cf134ded8e8499ffabcca5946b5c6d4`.
The sorted selected production-source digest is
`51d579ca88e5ba184bc1088121a5bb3e3bdae7de7d35e652586528c55a0dbe40`.
This has internal Team-boundary architecture impact, but it does not establish
full Team authority isolation. Real Pi and terminal-carrier operation remains
outside this focused source and harness evidence.

The rc.10 tree also includes the rc.9/rc.10 Coordination work: event-directed
Task hydration and page-safe watermarks, Worker run-state and actuation evidence,
a bounded Team-sync wait with an explicit `indeterminate` outcome, failed Task-
event hints, and delayed branch-bound sync nudges. These additions are current
facts, not completion of the Coordination boundary. Phase-two branch-observation
and Alert-publication characterizations remain current-behavior evidence rather
than intended or normative contracts. The machine-operable
[current-to-target dependency map](subsystem-dependency-map.json) records the
same evidence and keeps facts, assessments, risks, test gates, and proposals in
separate fields.

Facts below come from source and tests. Boundary and refactor statements are
assessments against the accepted target. The Project behavior inventory remains
unclassified, so this audit does not silently promote current behavior into the
normative contract.

## Current ownership facts

### Team authority and Role realization

`src/utils/teams.ts` owns Team epochs, logical Workers, Membership generations,
exact Session binding, topology and Membership leases, lifecycle, and
TeamConfig compatibility. `withTeamTopologyLease` states the lock order as Team
topology, exact Membership, then TeamConfig (`src/utils/teams.ts:230`). Team
recreation keeps historical Memberships and writes a new epoch only after all
current Memberships end (`src/utils/teams.ts:328`, `src/utils/teams.ts:392`).
Exact teammate resolution scans and then revalidates the selected Membership
under its mutation lease (`src/utils/teams.ts:624`).

Runtime and Role realization is spread across `runtime.ts`,
`worker-resource-projection.ts`, `session-terminal.ts`, `team-terminal.ts`,
terminal adapters, Team carrier realization, and lifecycle code in
`extensions/pi-team-session-adapter.ts`. `extensions/index.ts` now retains Pi
composition, tool schemas/execution, and leader branch observation only. One current Membership admits one live process generation
(`src/utils/runtime.ts:78`). `WorkerLaunchBridge.ensureWorker` now lives in
`src/team-authority/worker-launch-bridge.ts` and plans reuse, first-binding
retry, or exact-Session recovery before carrier creation. It consumes the
Team-owned `TeamLifecyclePublication` port
(`src/team-authority/team-lifecycle-publication.ts:16`), rather than importing
Team-event or startup-observation implementations. The durable adapter stays
outside Team authority at
`src/adapters/durable-team-lifecycle-publication.ts:14`; it writes existing
Coordination evidence and performs bounded observation. `TeamLifecycleService`
now owns stop and shutdown policy through Team-owned `AssignedWorkGuard` and
`TeamLifecyclePublication` ports
(`src/team-authority/team-lifecycle-service.ts:38-85`). The durable Task guard
and stopped-event publisher remain adapters
(`src/adapters/durable-assigned-work-guard.ts:5`,
`src/adapters/durable-team-lifecycle-publication.ts:28`). The extension composes
these adapters and delegates stop/shutdown (`extensions/index.ts:412-416`,
`:1141-1142`). `TeamSessionLifecycleService` now owns Worker and lead placement
admission, exact Session binding, exact Membership leasing, runtime claim/fence,
lead-record persistence, session-bound/failed publication, and bound-Session
runtime writes (`src/team-authority/team-session-lifecycle-service.ts:14-71`).
The service moved the exact-lead-Membership assertion inside its admission path,
which closes the pre-service snapshot race. Pi retains placement observation,
hook/refusal/delivery/title/footer/nudge adaptation. The old
`src/utils/worker-launch-bridge.ts` is a compatibility re-export only. Durable
lead-Session discovery now lives in `findLeadTeamForSession`
(`src/utils/teams.ts:476`).

Team compatibility is not isolated. `TeamConfig` also carries resolved sync-
liveness policy, historical implementation provenance, Beads authority,
workspace, fingerprint, and Task-cutover fields (`src/utils/models.ts`).
`createTeam` captures sync-liveness settings once for the Team epoch
(`src/model-tool-contract/durable-model-tool-port.ts`,
`src/model-tool-contract/durable-model-tool-port.ts`), while current
compatibility no longer treats package version as a storage coordinate. This is
required current behavior, but it makes TeamConfig a shared persistence
envelope instead of a narrow Team contract.

### Task authority

The canonical Task card and version contracts remain `task-domain.ts` plus
`task-version-ref.ts`. Task update and journal command contracts now live in
`src/task-authority/contracts.ts`, which also owns the narrow
`TaskReconciliationQuery`. `BeadsTaskReconciliationQuery` implements that query
for one Team-scoped authority in
`src/task-authority/beads-reconciliation-query.ts`; the Pi composition root
injects it into `TaskChangeDelivery` (`extensions/index.ts`).
`BeadsTaskAdapter` owns metadata parsing, bounded TaskCard projection, opaque
versions, replay, CAS, and semantic outcomes
(`src/model-tool-contract/beads-task-adapter.ts:295`,
`src/model-tool-contract/beads-task-adapter.ts:378`). `BeadsTaskStore` owns native
CLI records and mutations. `beads-authority-adapter.ts` owns Team-scoped
authority resolution, exact actor fencing, semantic mutation, and the
consumer-side `TaskMutationPublicationPort`
(`src/model-tool-contract/beads-authority-adapter.ts:196`). Raw create, update,
and link functions require the port (`src/model-tool-contract/beads-authority-adapter.ts:327`,
`src/model-tool-contract/beads-authority-adapter.ts:420`,
`src/model-tool-contract/beads-authority-adapter.ts:510`); this module no longer
imports concrete Coordination, failed-hint, or Task-delivery writers.

The stateless `DurableTaskMutationPublication` adapter lives outside Task
authority (`src/adapters/durable-task-mutation-publication.ts:44`). It implements
the port with the existing Team-event, failed-hint, Task-delivery, recovery,
suppression, and owner-transition operations. The Pi composition root constructs
one publishing Beads adapter factory and supplies it to leader and Worker paths
([`extensions/index.ts:343`](../../../extensions/index.ts#L343)).
`BeadsTaskAdapter` has no default authority constructor: explicit read-only and
publishing factories supply its required authority
([`src/model-tool-contract/beads-task-adapter.ts:362`](../../../src/model-tool-contract/beads-task-adapter.ts#L362)).

`task-delivery.ts` owns Task-delivery meaning: exact recipient intent, precommit
owner-transition markers, committed projections, recovery records, tombstones,
presentation attempts, and successful-turn acknowledgement. Its required
consumer-owned `TaskDeliveryMembershipPort` resolves the current recipient and
runs both send and acknowledgement under the exact-recipient lease
([`src/utils/task-delivery.ts:139`](../../../src/utils/task-delivery.ts#L139),
[`src/utils/task-delivery.ts:978`](../../../src/utils/task-delivery.ts#L978),
[`src/utils/task-delivery.ts:1037`](../../../src/utils/task-delivery.ts#L1037)).
`DurableTaskChangeDeliveryMembership` implements the Team read and lease outside
Task delivery ([`src/adapters/durable-task-change-delivery-membership.ts:5`](../../../src/adapters/durable-task-change-delivery-membership.ts#L5)). Pi composition supplies it to the Session adapter
([`extensions/index.ts:345`](../../../extensions/index.ts#L345);
[`extensions/pi-team-session-adapter.ts:286`](../../../extensions/pi-team-session-adapter.ts#L286)).
Session steer is actuation only. A successful turn acknowledges presentation but
never mutates Task state. The characterization proves stale-recipient refusal,
send/stage/acknowledgement order, replacement refusal, failed-send replay, and
one acknowledgement ([`src/utils/task-change-delivery.characterization.test.ts`](../../../src/utils/task-change-delivery.characterization.test.ts)).

Task and delivery migration remain stopped-epoch compatibility paths in
`task-migration.ts` and `task-delivery-migration.ts`. Normal delivery refuses
noncanonical records with an explicit migration requirement
(`src/utils/task-delivery.ts:671`). `in-memory-team-port.ts` temporarily
re-exports `ModelToolTaskUpdateInput` and `ModelToolTaskJournalEntry` from the
Task-owned contract module, so existing internal imports remain compatible.

The accepted Task read seam owns generic `TaskAuthorityReadPort<T>` and the
separate `TaskAuthorityReadTeamPort` ([`src/task-authority/contracts.ts:21`](../../../src/task-authority/contracts.ts#L21)). `DurableTaskAuthorityRead` binds the Team adapter, creates the native store, and preserves the `task_read`, `task_read_many`, and `task_list` semantic traces ([`src/adapters/durable-task-authority-read.ts:8`](../../../src/adapters/durable-task-authority-read.ts#L8)). `DurableTaskAuthorityReadTeam` alone reads the Team configuration and preserves legacy-JSON, missing-workspace, and incomplete-binding errors ([`src/adapters/durable-task-authority-read-team.ts:6`](../../../src/adapters/durable-task-authority-read-team.ts#L6)). The Beads adapter receives a required explicit read authority; read-only and publishing factories both delegate reads through the port ([`src/model-tool-contract/beads-task-adapter.ts:362`](../../../src/model-tool-contract/beads-task-adapter.ts#L362)). Pi composition constructs the durable readers once and injects them into the factories, Coordination query bundle, guard, and delivery reconciliation ([`extensions/index.ts:339`](../../../extensions/index.ts#L339); [`extensions/pi-team-session-adapter.ts:300`](../../../extensions/pi-team-session-adapter.ts#L300)). Raw Task read/list exports, `storeFor`, optional `readMany`/`list`, legacy read factories, and consumer defaults are removed.

Independent acceptance from `cb38d9254dd0cccb9e745a8df3edb27f367d852d` passed the two binding files (14 tests), then the selected full-config changed/new sweep plus benchmark (28 files, 207 tests), typecheck, 113-file lane closure (92 fast, 21 exhaustive), agent-surface QA, tool-result QA, and clean-package/generated-dist verification. The public differential found only internal extension composition; package exports, `src/public`, observation configuration/declarations, raw/default fences, and trace/error/projection parity passed. This is not an aggregate result. An accidental unfiltered full-Vitest attempt ran earlier on an unstable tree, found blockers, and is historical non-aggregate evidence only.

The accepted read and delivery seams change internal Task ownership and composition. Independent re-verification requires the mandatory delivery port, no local Team read or lease fallback, both exact-recipient leases, behavior/order parity, release-P1 fixture, typecheck, focused tests, public/persistence diffs, and source fences. No aggregate ran. This deterministic evidence does not prove a real Pi process, Beads/Dolt contention, external writers, native watcher delivery, OS scheduling, or terminal pixels. Stopped migration remains separate. Later accepted ports close the Pi Session Team-query and Coordination hidden-observation seams; remaining Team, Task, and Coordination target violations stay open.

### Alert authority

The stable accepted Alert-port production tree keeps canonical Alert meaning in
`src/alert-authority/alerts.ts` and `contracts.ts`; durable inbox acceptance,
fan-out, reads, acknowledgement, and legacy IDs live in `inbox-delivery.ts` and
`delivery-contracts.ts`; exact-Membership Pi presentation and replay live in
`direct-delivery.ts`. The old `src/utils/alerts.ts`, `messaging.ts`, and
`message-delivery.ts` paths are compatibility re-exports only. This preserves
public tools, schemas, package exports, inbox record shapes and filenames,
ordering, retry, timing, exact errors, console diagnostics, and ALERT-004.

Alert owns `AlertMembershipPort`: a name-only current-recipient roster, one
current-delivery lease that resolves durable Membership IDs only inside the
adapter, and an exact Session-binding check. It also owns
`AlertPublicationPort` for accepted Alert event publication. `DurableAlertMembership`
and `DurableAlertPublication` implement those ports outside Alert authority.
Pi composition creates one `AlertSender` for both leader and Worker direct-
delivery paths. Alert authority neither mirrors Team state nor exposes or
accepts `membershipId` as a roster coordinate, and it has no compatibility
singleton. The durable adapters retain Team configuration/lease and
Coordination-event implementation imports.

This preserves the prior lock and order: current-delivery lease and inbox
acceptance occur before publication, fan-out remains parallel with roster-order
receipts, and publication failure retains ALERT-004 behavior. Focused source and
harness tests do not prove native watches or locks, OS scheduling, a real Pi
turn, process, fork, Pi Session, or OS restart. No aggregate ran.

The Message names remain implementation vocabulary. Public work uses typed
Alerts, while durable records remain `InboxMessage` and the actuator keeps
`pi-teams-message/2`. This is compatibility, not a sixth Message subsystem.
Focused tests prove deterministic validation without delivery/event effects,
parallel fan-out with roster-order receipts, debounce/poll and replacement
control flow, plus ALERT-004 replay behavior. They do not prove native watches,
filesystem locks, operating-system scheduling, or real Pi turn delivery.

### Coordination observation

`team-events.ts` owns the append-only event journal, monotonic cursors, bounded
pages, check-register-check waits, and snapshot projection helpers. It appends
only after an owning authority commits (`src/utils/team-events.ts:278`). Its
page cursor is the last represented event rather than the unseen journal head
(`src/utils/team-events.ts:323`), and filesystem notifications remain hints; the
post-registration read closes the lost-wakeup gap
(`src/utils/team-events.ts:424`).

`CoordinationHiddenObservationPort` owns acknowledged branch projection reads
and commits. `DurableCoordinationHiddenObservation` implements the existing
hidden-record operations outside Coordination, and composition injects the
resulting observation store ([`src/coordination/queries.ts:68`](../../../src/coordination/queries.ts#L68); [`src/adapters/durable-coordination-hidden-observation.ts:10`](../../../src/adapters/durable-coordination-hidden-observation.ts#L10); [`extensions/index.ts:351`](../../../extensions/index.ts#L351)). Exact Team epoch, lead Session, branch lineage, pending state, and commit-before-cache-reuse behavior remain characterized ([`src/coordination/hidden-observation-port.characterization.test.ts`](../../../src/coordination/hidden-observation-port.characterization.test.ts)). `DurableModelToolTeamPort.readTeamSync`
now composes page-safe event reads, event-directed Task hydration, complete
quiet-journal rescans, exact cached baselines, Worker run-state and actuation
evidence, configured bounded waits, projection hashes, failed-event hint
cursors, and pending acknowledgement
(`src/model-tool-contract/durable-model-tool-port.ts`). It returns
`indeterminate` without position advance when run-state evidence cannot prove a
productive or complete wait (`src/model-tool-contract/durable-model-tool-port.ts`).

Slice B introduces minimal Coordination-owned query DTOs in
`src/coordination/queries.ts`: Team runtime evidence, Task state plus delivery
evidence, Alert inbox actuation evidence, and one explicit query bundle. Three
durable adapters retain the concrete reads outside Coordination:
`durable-coordination-team-runtime.ts`,
`durable-coordination-task-state-delivery.ts`, and
`durable-coordination-alert-actuation.ts`. Pi composition constructs exactly
one durable bundle and injects it into `DurableModelToolTeamPort`; the optional
constructor dependency keeps existing direct constructors and default behavior
usable. `sync-liveness.ts` now derives `active`, `settled`, `unknown`, or
`absent` purely from those inputs, while `waitForLivenessHint` retains its event/
runtime hints and periodic Task-authority recheck (`src/utils/sync-liveness.ts:27`,
`src/utils/sync-liveness.ts:87`). No observation service or nudge actuator moved.
Slice C moves the observation algorithm into
`CoordinationObservationService`. It owns snapshot/update/page/hydration/wait
control, revisions, pending presentation, cached Task projections, branch
lineage, and acknowledgement. Its injected dependencies are the query bundle,
durable observation store, liveness waiter, and projection functions. The
model-tool facade delegates while preserving result aliases and default
construction compatibility. Outputs, cursor progression, bounded waits,
acknowledgement, and the quiet five-second cadence remain unchanged.
`task-event-failure-hints.ts` stores payload-light derived evidence when Task
state commits but its Team event does not; Coordination matches only the current
epoch, Task identity, and version (`src/utils/task-event-failure-hints.ts:115`,
`src/utils/task-event-failure-hints.ts:165`). The accepted nudge boundary gives
Coordination `CoordinationNudgeDebtService`, neutral Task-projection revision,
event pagination, failed-hint provenance, exact debt identity, and eligibility
(`src/coordination/nudge-debt.ts`, `src/coordination/task-projection-revision.ts`).
A durable Coordination store reads derived evidence, while
`DurableCoordinationNudgeRecord` owns the existing JSONL reservation and
promotion storage behind the Pi-consumed record port. `SyncNudgeConductor` owns
timers only. Pi alone revalidates the exact Team epoch, lead Membership,
Session, and full branch; reserves; sends the unchanged custom message; proves
that exact persisted message; and then promotes the record
(`extensions/pi-team-session-adapter.ts`). With logical Workers, legacy records
without policy-version provenance keep their undefined-interpolated debt-key
shape. The nudge-specific outer binding avoids an early `none` or no-active-Team
result, but its durable hidden-observation read still applies
`teamModelToolContractGap`; absent logical Workers therefore returns the exact
legacy unavailable result. Snapshot and update observation retain their
logical-Worker requirement. Derived records and timers never become Team, Task,
Alert, or acknowledged-observation authority. The separately reproduced baseline
terminal-admission defect is corrected by
`cafdf2deb4ccdbb47cb40b87e83081d1c9128665`; it was not a nudge regression.

Worker startup observation consumes coordination events, but it verifies current
Team and runtime authority before claiming success. Its three-second wait is
bounded launch evidence, not Worker readiness or progress
(`src/utils/worker-startup-observation.ts:5`,
`src/utils/worker-startup-observation.ts:44`).

### Trio-facing interface and projections

`catalog.ts` owns public input and raw-result schemas. `pi-registration.ts`
registers the ten operations. `executors.ts` maps calls to the current port.
`result-projection.ts` validates raw machine details and derives concise model
JSON. `tui-projection.ts` derives collapsed and expanded human views.
`assembleToolResult` preserves raw semantic details as machine truth and
serializes the validated model view separately
(`src/model-tool-contract/result-projection.ts:383`). The rc.10 trio contract
also projects `caught_up` and `indeterminate` sync outcomes without inventing
Task or Worker state (`src/model-tool-contract/result-projection.ts:300`).

`extensions/index.ts` is both the Pi composition root and a second application
layer. Its process closure holds role, Team, Membership, delivery, tool, footer,
model, and sync-nudge state (`extensions/index.ts:363`,
`extensions/index.ts:376`). It also contains Worker
schemas and execution beside the leader journey (`extensions/index.ts`).
`team-status.ts` and `team-footer.ts` are human projections, but they import Team
and Task implementations directly (`src/utils/team-status.ts:4`,
`src/utils/team-status.ts:6`, `src/utils/team-footer.ts:9`).

### Additive Membership observation

`src/team-authority/membership-observation-reader.ts` is the sole private
Team/runtime filesystem decoder. It owns lock-free reads, config/runtime/config
retry, deadline and AbortSignal control, ordering, and diagnosis of mixed or
old records. `src/public/observation.ts` is one-way: no core production module
imports it. It owns only the existing `pi-teams-observation/1` machine DTO, JSON
Schema, and projection over reader evidence. The public module imports only the
reader and package metadata. The reader and projector preserve the allowlist and
never assert OS liveness. This is additive, not a core subsystem.

## Boundary assessments

1. **Resolved in the implemented Task seam.** `beads-task-adapter.ts` now
   imports `ModelToolTaskUpdateInput` and journal types from
   `src/task-authority/contracts.ts`. The trio-facing
   `in-memory-team-port.ts` imports and re-exports those types for compatibility;
   Task authority no longer depends upward on the model-tool test double.

2. **Resolved for Task mutation publication.**
   `beads-authority-adapter.ts` retains Task mutation and exact actor/lease
   orchestration but depends on only its consumer-side publication port. The
   durable adapter outside Task authority imports the concrete event, failed-
   hint, and delivery operations (`src/adapters/durable-task-mutation-publication.ts:1`,
   `src/adapters/durable-task-mutation-publication.ts:8`). Composition injects
   one publishing factory into leader and Worker mutations. Import fences and
   deterministic interleavings prove this is dependency inversion, not i37's
   rejected relocation (`src/adapters/durable-task-mutation-publication.test.ts:195`,
   `src/model-tool-contract/task-mutation-publication-order.test.ts:128`).

3. **Resolved for reconciliation.** Task delivery imports the Task-owned query
   contract and receives its Beads implementation at composition. It contains
   no static or dynamic Beads Task-adapter import
   (`src/utils/task-delivery.ts:18`, `extensions/index.ts`). The production
   static file graph remains acyclic. Task mutation now uses the injected
   publication port, so reconciliation and publication dependencies both point
   through explicit seams.

4. Slice C removes snapshot/update observation algorithm ownership from the
   durable model-tool facade: it delegates to `CoordinationObservationService`.
   The service owns pending, cache, branch, and acknowledgement state through
   injected query/store/wait/projection dependencies. `ModelToolTeamPort` still
   combines Team, Task, Alert, Coordination, launch context, sync-nudge debt,
   and the public observation entry points in one interface
   (`src/model-tool-contract/in-memory-team-port.ts`). Its in-memory
   implementation stores Team state, Task state, replay records, event history,
   branch baselines, pending observations, and waiters in one `StoredTeam` and
   class (`src/model-tool-contract/in-memory-team-port.ts`,
   `src/model-tool-contract/in-memory-team-port.ts`). This test seam can make
   cross-authority atomicity appear easier than the durable system.

5. `DurableModelToolTeamPort` still directly composes Task, Team, Alert,
   Coordination, liveness, failed-event-hint, nudge-debt, and Worker-launch
   behavior (`src/model-tool-contract/durable-model-tool-port.ts:1`). It no
   longer imports or constructs `DurableTeamLifecyclePublication` or
   `createWorkerLaunchBridge`; composition injects an optional
   `WorkerLaunchBridge`. Read-only snapshot and nudge-debt use remains available
   without it, while `ensureWorker` refuses `carrier_unavailable` before a
   logical-Worker mutation when it is absent. Its five process maps hold Session
   files, launch context, branch lineage, pending observations, and exact
   acknowledged Task projections (`src/model-tool-contract/durable-model-tool-port.ts`).
   It is a useful façade, not one subsystem port. The accepted nudge extraction
   removes nudge debt, identity, pagination, and record storage from this façade,
   but it deliberately leaves Pi exact-Session actuation and proof at the
   integration boundary.

6. **Resolved for durable lead discovery, Worker carrier
   publication/observation, and the Pi Session adapter selection.**
   `extensions/pi-team-session-adapter.ts` is the one mutable Pi hook and
   identity boundary. It delegates durable
   lead-Session discovery to Team authority. Team carrier realization consumes
   the required `TeamLifecyclePublication` port, and the external durable
   adapter preserves prepared-event, cursor, bounded-observation, and exact
   Membership/runtime verification order
   (`src/team-authority/worker-launch-bridge.ts:194`, `:307`, `:437`;
   `src/adapters/durable-team-lifecycle-publication.ts:14`). The port is
   runtime-required for Worker ensure, although its dependency field remains
   optional for the reusable prepared-launch service. The former utils
   module is a compatibility re-export. Independent review passed 38 focused
   tests. Later accepted selections moved Team assigned-work guarding,
   stop/shutdown orchestration, and Session admission/claim/bind/runtime
   realization into Team authority. Pi retains hook/refusal/delivery/title/footer/
   nudge adaptation, while durable façade composition remains open. The accepted
   two-file launch-capability injection removes the façade's direct durable
   lifecycle-adapter construction, but it does not split the combined façade or
   move Pi Session adaptation. The adapter starts delivery engines, composes sync-nudge reservation and
   exact-branch presentation, and owns hook order. `extensions/index.ts` wires
   composition, tool schemas, and leader branch observation. Envless Worker
   recovery re-projects only the Worker tool surface and suppresses leader branch
   hooks (`src/utils/pi-session-adapter.characterization.test.ts`).
   `PiSessionTeamQueryPort` now supplies Team resolution, exact binding,
   placement, profile, and nudge-candidate reads. Its durable adapter keeps the
   concrete Team operations outside Pi Session adaptation. TeamConfig mixed
   compatibility remains a separate Team seam.

7. `models.ts` and `paths.ts` act as shared registries. `models.ts` mixes Team,
   runtime carrier, Task relation, Coordination event, sync-liveness policy,
   Alert, and delivery Message types (`src/utils/models.ts:15`,
   `src/utils/models.ts`, `src/utils/models.ts`,
   `src/utils/models.ts`, `src/utils/models.ts`). `paths.ts` exposes
   every authority's private and derived records through one support module
   (`src/utils/paths.ts:26`, `src/utils/paths.ts:34`,
   `src/utils/paths.ts:39`, `src/utils/paths.ts:59`,
   `src/utils/paths.ts:69`, `src/utils/paths.ts:86`). Paths own no truth, but the mixed type file
   does.

8. **Implemented Alert ports.** Alert owns consumer-side membership and
   publication ports in `contracts.ts`. The membership port exposes only names
   for the roster, resolves Membership IDs only during the current-delivery
   lease, and verifies an exact recipient Session binding. `DurableAlertMembership`
   and `DurableAlertPublication` keep Team and Coordination calls outside Alert
   authority. `extensions/index.ts` composes one explicit `AlertSender` for
   leader and Worker direct-delivery use. No Team mirror, `membershipId`-leaking
   port shape, or compatibility singleton remains. The slice-B source graph had
   92 production files, 304 unique resolved static local edges, zero cycles, and
   zero dynamic imports. This is historical behavior-preserving dependency
   evidence; the current slice-C graph is 94/320. Public behavior is
   unchanged. ALERT-004 remains compatibility-required and needs a separate
   owner-visible decision for any semantic change.

9. **Resolved for the Team stop/shutdown slice.** `TeamLifecycleService` holds
   the Team topology lease, asks its consumer-owned `AssignedWorkGuard` for
   nonterminal Task IDs, stops an exact carrier, deactivates under the exact
   Membership lease, then publishes a stopped event
   (`src/team-authority/team-lifecycle-service.ts:44-55`, `:113-118`). The
   concrete Task query and Coordination write stay in durable adapters. A
   stopped-publication failure remains a characterized post-deactivation refusal,
   not evidence of rollback. Task creation still validates a logical Worker
   (`src/model-tool-contract/durable-model-tool-port.ts`), so consumer-owned
   ports remain necessary to prevent source cycles.

10. **Partly resolved in slice B.** Coordination now reads Team runtime, Task
    state/delivery, and Alert inbox actuation through its consumer-owned query
    DTOs. Three durable adapters keep concrete authority reads outside
    Coordination, and `WorkerRunObservation` is a pure derivation rather than
    another authority. `DurableModelToolTeamPort` and Pi composition still
    combine broader Coordination behavior. Hidden observation now uses its
    Coordination-owned port; concrete runtime/event reads and nudge actuation
    remain later seams.

11. **Resolved for additive Membership observation.** The private reader
    decodes Team/runtime records and returns only narrow evidence and diagnoses.
    The public projector retains the existing machine contract. Static fences
    deny core imports of the public module and deny public filesystem, runtime,
    and Team-contract imports. Focused tests preserve deadline, abort, retry,
    order, privacy, old-record diagnoses, and package export behavior.

## Risks and unresolved test gates

- `TASK-READ-PORT` and `TASK-CHANGE-DELIVERY-PORT` are closed by independent
  acceptance. They prove the generic read port, distinct read-Team binding,
  required exact-recipient delivery port, raw/default removal, trace/error/public
  projection parity, and delivery ordering. They do not prove live process,
  storage contention, external writers, watchers, scheduling, or terminal
  behavior. Stopped migration remains separate. The Pi Session Team-query and
  Coordination hidden-observation seams are closed; remaining Team, Task, and
  Coordination target violations stay open.

- `ALERT-PUBLICATION-FAILURE` is classified compatibility-required for this
  behavior-identical Project. Alert delivery records can be accepted before
  `appendTeamEvent` fails
  (`src/alert-authority/alerts.ts`). Independently verified
  characterization records an ambiguous unavailable
  result, retained native delivery, duplicate delivery after retry, unchanged
  Task state, and no event for the first Alert
  (`src/utils/alert-publication-failure.characterization.test.ts`). One Node
  process directly drives two registered extension harnesses and same-Session
  lifecycle hooks. It proves later exact-Session presentation and hook-level
  replay after an error, not a process, fork, Pi Session, or OS restart.
  External process evidence remains a proof limit, but does not block the
  behavior-identical compatibility seam. A semantic change still needs a
  separate owner-visible decision.
- `TASK-RECONCILIATION-INJECTION` is closed. Four independent deterministic
  tests run the injected query through self-authored suppression, a later
  external change, owner-marker recovery, exact replacement binding, delivery
  ID deduplication, recovery replay, and metadata-gap refusal
  (`src/task-authority/reconciliation-equivalence.test.ts`). Source fences also
  prove that Task delivery has no Beads adapter import and the Beads Task adapter
  has no in-memory-port import. This evidence covers reconciliation equivalence;
  the separate publication gate covers mutation publication.
- `TASK-PUBLICATION-INVERSION` is closed. Deterministic tests force preparation
  inside the Membership lease and block event publication after lease release;
  preserve event, failed-hint, serial delivery, inline recovery, suppression,
  and completion order; preserve exact warnings and failure continuation; prove
  that an acting-Session no-op still suppresses without event, delivery, or
  completion while an exact create replay calls no publication-port method; and
  fence concrete imports outside Task authority
  (`src/model-tool-contract/task-mutation-publication-order.test.ts:128`,
  `src/adapters/durable-task-mutation-publication.test.ts:79`,
  `src/adapters/durable-task-mutation-publication.test.ts:139`,
  `src/adapters/durable-task-mutation-publication.test.ts:195`). Independent
  verification passed 113 focused tests, typecheck, result QA, lane closure,
  package, public-surface, persistence, and diff checks. It did not run the
  aggregate lane.

- The completed Membership boundary passed 22 focused public-reader tests,
  TypeScript, package/export, generated-output, static-fence, and diff checks.
  The packed CommonJS and TypeScript probe retains the public observation
  subpath. Its lock-free reader creates no producer artifact and leaves the
  separate Beads/Dolt resource-contention risk open.
- Slice B has focused query-equivalence, liveness, hydration, nudge, extension,
  and E2E evidence. It preserves explicit `indeterminate` outcomes, branch-safe
  position, constructor/default compatibility, and the unchanged five-second
  quiet cadence. It proves the three read dependencies moved behind minimal
  Coordination query ports, not a separated Coordination application service or
  nudge actuator.

The upward Task-to-trio type risk, hidden dynamic reconciliation cycle, and
concrete Task publication dependencies are closed, and durable lead discovery
now belongs to Team authority. The main remaining structural risks are one
façade and one in-memory fake that combine all authorities, Coordination
liveness reading three authorities, hook-order coupling in the Pi composition
root. The completed Membership reader is no longer a broad private-record
public dependency. These risks do not authorize behavior changes.

## Preserved state, timing, and ordering facts

- Team lock order is topology to Membership to TeamConfig. Membership leases
  remain held across slow Task writes so replacement or shutdown cannot pass a
  stale actor (`src/utils/teams.ts:791`, `src/utils/teams.ts:811`).
- New Worker order is resource validation, Membership prepare, prepared event,
  terminal spawn, carrier binding, then bounded startup observation
  (`src/team-authority/worker-launch-bridge.ts:133`). The Team carrier service
  requires its publication port when it executes Worker ensure, while the
  reusable prepared-launch method remains usable without it. Compensation
  deactivates only after exact carrier-stop proof
  (`src/team-authority/worker-launch-bridge.ts:468`, `:474`).
- Process startup order is runtime-generation claim, Membership Session bind,
  then `session_bound` event (`extensions/index.ts`,
  `extensions/index.ts`, `extensions/index.ts`). A post-claim failure
  deliberately leaves a runtime fence until PID exit.
- Normal Task mutation commits Beads first and releases the Membership lease,
  suppresses the acting Session when needed, appends event evidence, then
  enqueues recipients serially. Event and delivery failures produce the same
  degraded warnings and do not roll back Task state
  (`src/model-tool-contract/beads-authority-adapter.ts:327`,
  `src/adapters/durable-task-mutation-publication.ts:57`). An event-append
  failure writes a derived failed-event hint before delivery
  (`src/adapters/durable-task-mutation-publication.ts:94`).
- Assignee changes first prepare delivery intent, then embed its operation ID in
  the Beads mutation, mark it committed, and dispatch exact recipients
  (`src/utils/task-delivery.ts:340`, `src/utils/task-delivery.ts:416`). Recovery
  trusts only the matching Beads marker (`src/utils/task-delivery.ts:473`).
- Task and Alert presentation use filesystem hints plus 30-second fallback
  scans. Context observation stages IDs. Only a non-error, non-aborted turn
  commits acknowledgement (`src/utils/task-delivery.ts:950`,
  `src/alert-authority/direct-delivery.ts`). Restart replays presented but
  unacknowledged records. Concurrent test changes now characterize aborted
  turns and failed Session sends (`src/utils/delivery-round3.test.ts`).
- A Team epoch captures its sync wait and nudge policy once. The wait defaults to
  120 seconds and settings bound it from zero through 3,600 seconds
  (`src/utils/sync-liveness-settings.ts:6`,
  `src/utils/sync-liveness-settings.ts:8`,
  `src/model-tool-contract/durable-model-tool-port.ts`,
  `src/model-tool-contract/durable-model-tool-port.ts`). `team_sync` must
  publish one complete observation or none; `indeterminate` does not advance
  position, and hidden state advances only after the exact result persists on
  the active branch (`src/model-tool-contract/durable-model-tool-port.ts`,
  `extensions/index.ts:475`).
- Runtime constants of 90 seconds for heartbeat staleness, 60 seconds for
  startup stall, and five minutes for stale files are diagnostic policy, not
  work state (`src/utils/runtime.ts:11`, `src/utils/runtime.ts:12`,
  `src/utils/runtime.ts:13`). Membership observation has a separate
  one-second default deadline (`src/public/observation.ts`). Coordination
  run state uses exact generation and actuation evidence instead of heartbeat or
  terminal activity (`src/utils/sync-liveness.ts:27`).
- Alert fan-out is per-recipient and partial. Accepted inbox writes precede one
  combined Alert event (`src/alert-authority/alerts.ts`).
- Sync nudges reserve before send and become presented evidence only after the
  exact custom message exists on the same full branch lineage
  (`src/utils/sync-nudge.ts:47`,
  `extensions/pi-team-session-adapter.ts`). They request reconciliation and
  never mutate Task or Team authority. The rejected early policy-version gate
  would have changed legacy debt keys. Reusing normal observation binding would
  have returned early `none` for absent logical Workers; the accepted outer
  resolver avoids that shortcut, while durable hidden observation preserves the
  exact legacy unavailable result.
- Compatibility readers preserve legacy Memberships, inbox IDs, terminal
  fields, Task cutover evidence, and mixed event/delivery records.

## Full-split completion matrix

The recomputed machine-operable completion matrix is
[`subsystem-dependency-map.json`](subsystem-dependency-map.json) under
`completionMatrix`. Its source input is baseline
`1686ac19dc83143e55c7a68062e1a30c1e53fa6d` plus the accepted four-path Pi
Session adapter selection: 81 production TypeScript files, 266 unique resolved
static local edges, no literal relative dynamic import, no self-cycle, and no
nontrivial SCC. The source digest is
`51d579ca88e5ba184bc1088121a5bb3e3bdae7de7d35e652586528c55a0dbe40`.

Task reconciliation and mutation publication remain closed Task seams. The
Membership projection, Alert ports, Trio split, Pi Session Team-query, and
Coordination hidden-observation ports are complete. The matrix keeps Team/Task
concrete reverse dependencies plus Coordination runtime, event, and nudge-
actuation seams open because they remain target violations. Close those gates
before performance, aggregate, privacy, and watchdog gates. The matrix records every remaining concrete or
support-mediated seam, its source paths, required source fence, focused test
command, blocker, and safe order. It does not treat the acyclic current file
graph as a completed authority split: the main remaining violations are Team
and Task direct reverse dependencies, Alert direct Team and event writes,
Coordination's concrete Team/runtime/Task-delivery/Alert-inbox reads, the
combined durable and in-memory Trio façade, and the broad public observation
decoder.

## Proposed dependency direction

```text
Pi composition root
  -> trio-facing registration and projections
    -> Team application port
    -> Task application port
    -> Alert application port
    -> Coordination observation port

Coordination observation
  -> read-only Team query port
  -> read-only Task query port
  -> read-only Alert change/query port

Task authority
  -> consumer-owned current-Membership resolver
  -> consumer-owned mutation-publication port, implemented by composition
  -> Task-owned delivery and recovery records
  -> shared SessionActuator interface
  -> lock, atomic write, trace, and path support

Alert authority
  -> consumer-owned current-Membership resolver
  -> Alert-owned delivery and recovery records
  -> shared SessionActuator interface
  -> support

Team authority and Role realization
  -> consumer-owned assigned-work guard query
  -> process and terminal carrier adapters
  -> Worker resource readers
  -> support

public Membership observation
  -> narrow read-only Team/runtime record projection
```

No authority imports trio schemas or renderers. Coordination hydrates current
authorities and never decides Task or lifecycle policy. Session actuation,
terminal adapters, locks, paths, tracing, and atomic writes own no domain
record. Cross-authority interfaces belong to the consumer and are implemented
at the composition root.

## Smallest coherent refactor plan

1. **Partly implemented.** Task commands, journal entries, and the
   reconciliation query live in a Task-owned contract directory.
   `in-memory-team-port.ts` keeps temporary type re-exports. `TaskCard`,
   `TaskVersionRef`, and other outcomes remain at their current paths.
2. Split `models.ts` into Team, Coordination-event, and Alert-delivery
   contracts. Keep `models.ts` as a compatibility re-export. Do not change
   persisted shapes.
3. Define narrow application interfaces for Team, Task, Alert, and
   Coordination. Make `ModelToolTeamPort` a trio-facing façade. Split the
   in-memory implementation into separate fakes so tests cannot assume one-store
   atomicity.
4. **Implemented and independently verified.** Owner-transition intent,
   recovery, tombstones, and compatibility remain in Task authority. The
   injected Task query replaces dynamic Task-adapter imports. The consumer-owned
   mutation-publication port replaces concrete Coordination and delivery imports
   in Task mutation, while the durable adapter stays outside Task authority.
   Composition injects one publishing factory into leader and Worker paths;
   exact order, lease, warning, recovery, acting-Session no-op suppression
   without event/delivery/completion, exact create-replay silence, and
   import-direction gates pass.
5. **Implemented.** Alert owns the name-only roster, current-delivery lease,
   exact Session-binding, and publication ports. Durable Team and Coordination
   adapters sit outside Alert authority; composition injects one sender without
   a singleton. Keep the retained ALERT-004 characterization. Do not add an
   outbox, operation ID, recovery record, or warning change.
6. **Partly implemented in slice C.** `CoordinationObservationService` owns
   page-safe `team_sync`, event-directed hydration, complete quiet-journal
   rescans, liveness/wait control, revisions, pending/cache/branch state, and
   hidden acknowledgement. It receives Coordination queries, durable storage,
   wait, and projection dependencies; the facade delegates. Preserve failed-event
   hints, nudge debt, outputs, cursors, waits, acknowledgement, and the
   five-second cadence. Nudge actuation, the Trio facade, and concrete
   Coordination runtime/event reads remain later seams. The unused
   `readAllNudgeEvents` helper is later local cleanup.
7. **Partly implemented.** Durable lead-Session discovery, Worker carrier
   publication/observation, Team stop/shutdown policy, and Team Session
   admission/claim/bind/runtime realization now use Team-owned contracts. The
   Session service owns the exact-Membership race correction. The external
   durable adapters implement Task query and lifecycle publication. Exact
   carrier stop, Membership transition, stopped publication, partial shutdown,
   lead-last order, Session-bound publication, and runtime-fence failures remain
   characterized. The launch-capability selection injects the optional Worker
   bridge and removes direct lifecycle-adapter construction from the durable
   façade. It preserves read-only/nudge calls and refuses absent launch capability
   before logical Worker mutation. The private `teamCreated` model-lifecycle path
   proves adapter wiring only; it is not a Pi-process or hook-execution proof.
   Keep Pi hook/refusal/delivery/title/footer/nudge adaptation small. Team
   authority retains resource resolution, startup, recovery, stop, shutdown, and
   compatibility policy.
8. Keep result and TUI projection, catalog schemas, and Pi registration above
   the semantic application ports. Make status and footer consume query DTOs.
9. **Implemented.** The Membership reader is the narrow read-only Team/runtime
   decoder. The public export and schema are unchanged, and import fences keep
   core independent from the public projector.
10. Static dependency tests and outside-in characterization remain required for
    future changes. Do not replace the completed boundaries with a directory
    rename or whole-system rewrite.

`TASK-RECONCILIATION-INJECTION` and `TASK-PUBLICATION-INVERSION` now prove the
implemented Task dependency boundaries. They remove the clearest upward type
dependency, hidden dynamic reconciliation cycle, and concrete mutation-
publication writers without changing a public operation, persisted record, or
runtime order. The rebased rc.10 tree adds substantial Coordination behavior and
evidence, but it does not complete Team, Alert, Coordination, Trio, or additive
Membership-observation boundaries. ALERT-004 is compatibility-required and
has hook-level later-presentation and replay characterization. Its external
process boundary remains a proof limit, not a gate on behavior-identical Alert
refactoring; semantic change still needs a separate owner-visible decision.
