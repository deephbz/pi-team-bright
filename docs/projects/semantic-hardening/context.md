# Pi Team Bright semantic hardening

Updated: 2026-08-11
Stage: consolidation and hardening
Status: Exact committed source `bea6f45572ba34f5e29574cc489f45383b7ebc19`
passed its single final-verification aggregate: TypeScript plus 118 test files
and 863 tests in 289.91 seconds. Package/generated, lane, QA, JSON, local-link,
privacy-range, graph, and diff closure remain recorded with the final
verification receipt. This is local deterministic evidence. It does not prove a
real Pi process, Beads/Dolt contention, external writers, watcher delivery, OS
scheduling, terminal pixels, publication, registry state, or provenance.
Architecture impact: changed for internal Task, Team, and Alert dependency ownership;
HyperCarrier's canonical diagram remains unchanged because it keeps Pi Team
Bright internals opaque

## Outcome and current result

The Project makes current functional and non-functional behavior executable,
then moves source dependencies toward five semantic subsystems without changing
the public surface by default. The durable concise outcome is
[`result.md`](result.md). The accepted decomposition and current evidence live in
the [`subsystem audit`](subsystem-boundary-audit.md) and machine
[`dependency map`](subsystem-dependency-map.json).

The ten-commit series from public rc.10 integration base
`7453ce1b2a2ca49f8729a6bf399f7c1f25bfca6a` ends at
`15e707b5668af383d6949934bd8e67a35b8bc097`. It adds outside-in
characterization, two Task dependency seams, Team-owned lead discovery,
duplicate-validation removal, deterministic lock tests, a reproducible Task-
hydration benchmark, and rc.10 audit evidence. Public tools, schemas, package
exports, persisted records, filenames, retry, timing, and default behavior are
unchanged.

The superseded rc.8 publication patch stash was removed after the reviewed rc.10
implementation entered `15e707b`; no Project stash remains.

Commit `d781f82` preserves the Task-owned `TaskAuthorityProvisioningPort` and
its durable adapter. It moves existing-binding validation, legacy refusal,
orphan-cutover validation, workspace initialization, and native-store validation
outside Team application code. The snapshot is copied and frozen. The leader ran
the focused provisioning and durable-port checks (38 tests) plus TypeScript before
this commit. This is local deterministic evidence; a compliant independent Worker
must still recheck it. Exact source commit
`638d5934bd52c7f4a3fe18525e5d72569a227211` adds the result bundle and rc.11
release metadata. Its one reserved Node 22.22.1 aggregate passed 88 files and 695
tests in 253.59 seconds. Lane, package, QA, public, persistence, JSON, link,
privacy-range, exact-tarball, observation, Beads, and Pi-load gates passed.

The partial source is pushed only to remote branch `rc/v0.17.0-rc.11`. It
remains untagged and is not published to npm. `origin/main` and npm `next` stay
on rc.10. No registry, provenance, GitHub release, or published-release receipt
exists. Full Team runtime, terminal rendering, and model interpretation remain
outside the source-verification claim.

## Active continuation

The accepted Trio split closes the combined durable facade and one-store fake
seam. Accepted commit `5950f3b3f17124b9baf38afa48d839dc503d847b` closes the
final additive Membership-observation boundary. `ModelToolJourneyPort` is the named facade over neutral Team, Task, Alert,
and Coordination application contracts. The durable owners are
`durable-model-tool-team-application.ts`, `durable-model-tool-task-application.ts`,
`durable-model-tool-alert-application.ts`, and
`durable-model-tool-coordination-application.ts`; bindings remain in
`durable-model-tool-bindings.ts`. `in-memory-state.ts` and
`in-memory-authority-ports.ts` keep authority state opaque, while
`in-memory-model-tool-journey.ts`, `in-memory-team-port.ts`, and
`durable-model-tool-port.ts` are thin compatibility wrappers. Task and Alert
commit before Coordination publication; a later publication failure remains a
partial outcome and never rolls back authority state. Rejected nominal attempts
remain historical evidence. Focused gates passed, but this is deterministic
local evidence only; it does not prove real Pi persistence, external
Beads/Dolt contention, cross-process forks, watcher delivery, OS scheduling,
external writers, or terminal pixels.

The owner rejected the prior partial-completion interpretation. Delivery now
requires the complete agreed request, not another bounded release increment:

- expand the behavior inventory and outside-in tests across functional and non-
  functional behavior for all five subsystems;
- preserve the completed Alert-port, Trio, and Membership-observation boundaries while closing the remaining Team, Task, and Coordination target gates;
- keep the completed additive Membership observation reader core-independent
  and its public contract unchanged;
- split mixed contracts and the combined durable/in-memory façade only through
  behavior-preserving, consumer-owned seams with static dependency gates;
- preserve public surfaces and observable behavior by default, and handle each
  justified behavior change through explicit evidence and its own commit;
- continue separate focused optimization commits only when a measured or
  reviewed problem justifies them;
- keep this context current and the journal append-only until every completion
  gate has external verification.

The isolated worktree and local audit branch were restored at documentation HEAD
`a3c51d7`. Remote branch `rc/v0.17.0-rc.11` contains that partial increment;
`origin/main` and npm `next` remain on rc.10. The current direct leader Session
has the required proxy environment and Herdr control. Dedicated watchdog
`ptb-full-split-watchdog` and direct-leader Team
`semantic-hardening-boundaries` are active. The first continuation Team shut down
only after all Tasks became terminal, which reset expensive Task-history
hydration without changing the direct leader. Worker-authored Task evidence now
covers the current source graph, all 27 behavior entries, Alert hook-level replay,
Team carrier replacement, and Trio projection parity. All 27 entries are
characterized with explicit proof limits; characterization does not make them
normative. The shared domain-contract split passed independent review and entered
commit `6b7fb14`. The watchdog checks both leader liveness and goal completion,
and must not accept a release increment as Project completion while any target
boundary or behavior gate remains open.

## Sources of truth

- [`result.md`](result.md) — concise outcome, optimization decisions, evidence,
  limits, and release gate.
- [`subsystem-boundary-audit.md`](subsystem-boundary-audit.md) — maintained
  ownership facts, citations, boundary assessments, risks, and direction.
- [`subsystem-dependency-map.json`](subsystem-dependency-map.json) — machine-
  operable graph, evidence, resolved gates, and remaining gates.
- [`behavior-inventory.json`](behavior-inventory.json) — behavior IDs,
  classifications, anchors, and proof limits.
- [`journal.md`](journal.md) — append-only chronology and corrections.
- The rc.11 [source verification
  receipt](../../journal/2026-08-09-v0.17.0-rc.11-source-verification-receipt.md)
  — exact aggregate, privacy, one-pack, artifact, canary, and publication limits.
- The original
  [`handoff`](../../journal/2026-08-09-semantic-hardening-and-subsystem-audit-handoff.md)
  and [baseline receipt](../../journal/artifacts/2026-08-09-semantic-hardening-baseline.json)
  — ratified scope and rc.8 declaration evidence.
- Source and tests — exact stable contracts. Docs keep intent, current status,
  decisions, evidence routes, and limits.

## Subsystem target and implemented seams

The five accepted core subsystems remain target boundaries:

1. Team authority and Role realization.
2. Task authority.
3. Alert authority.
4. Coordination observation.
5. Trio-facing interface and projections.

Public Membership observation is also complete, additive, and core-independent.
`src/team-authority/membership-observation-reader.ts` alone decodes private
Team/runtime filesystem records; `src/public/observation.ts` owns only the
unchanged allowlisted `pi-teams-observation/1` DTO, schema, and projection.
Session actuation, terminal adapters, locks, atomic writes, paths, tracing,
diagnostics, watch hints, and timers remain support mechanisms, not authorities.

Implemented Task seams are narrow. Task update and journal contracts plus
`TaskReconciliationQuery` are Task-owned, and Task delivery consumes the
injected query. Task mutation consumes the consumer-owned
`TaskMutationPublicationPort`; a stateless durable adapter outside Task authority
calls Coordination, failed-hint, and delivery writers. One publishing Beads
adapter factory reaches leader and Worker mutation paths, while default adapters
remain read-only.

Team authority now owns durable lead-Session discovery. Pi composition retains
environment precedence, hook timing, lifecycle orchestration, and adapter
construction. These changes remove concrete source dependencies; they do not
claim full Task, Team, or system isolation.

Commit `6b7fb14` gives Team, Task, Alert delivery, and Coordination events
canonical contract homes. Historical `utils/models.ts`, Task card, and Task
version paths remain exact compatibility re-exports. Production imports use the
canonical owners where this does not create a cross-authority implementation
edge. Persisted shapes and public package exports remain unchanged. Commit
`32e12b5` keeps historical generated observation filenames while adding required
canonical contract outputs; the packed CommonJS and TypeScript probes pass.

Commit `8d63473` moves Worker carrier realization into Team authority. A required
Team-owned publication port replaces concrete Coordination imports, and a
durable adapter outside Team owns event publication and bounded startup
observation. The old utility path is a compatibility re-export.

Commit `a2e3f9c` adds a Team-owned assigned-work guard and stop/shutdown
service. Concrete Task reads and stopped-event publication remain in external
adapters. The service owns topology and Membership leases, exact carrier-stop
proof, deactivation, partial shutdown, and result policy.

This Team selection adds `TeamSessionLifecycleService` for
lead and Worker startup admission, exact Membership leases, runtime-generation
claims, binding, lead-session records, session-bound/failed publication, and
exact bound-Session runtime updates. Pi hooks still own fork and identity
recovery, terminal admission inputs, UI/refusal, deliveries, titles, footer, and
callback order. Implementation Task `semantic-hardening-boundaries-3pt`, registered
order-characterization Task `semantic-hardening-boundaries-03r`, read-only
architecture review Task `semantic-hardening-boundaries-0xl`, and independent
test Task `semantic-hardening-boundaries-3w7` are closed. Correction Task
`semantic-hardening-boundaries-6g2` moved exact lead Session binding into the
Team service, and independent test Task `semantic-hardening-boundaries-76m`
closed the order gate. Exact-Membership correction Task
`semantic-hardening-boundaries-7kz`, race test Task
`semantic-hardening-boundaries-ggw`, and independent verification Task
`semantic-hardening-boundaries-5hg` are closed. Audit/map update Task
`semantic-hardening-boundaries-2vn` and final read-only record review Task
`semantic-hardening-boundaries-blb` are closed. Commit `57c8e02` contains the
independently accepted Team Session lifecycle selection.

The completed Task read boundary gives `TaskAuthorityReadPort<T>` and its distinct `TaskAuthorityReadTeamPort` canonical homes in [`src/task-authority/contracts.ts`](../../../src/task-authority/contracts.ts#L21). [`DurableTaskAuthorityRead`](../../../src/adapters/durable-task-authority-read.ts#L8) preserves the `task_read`, `task_read_many`, and `task_list` traces. [`DurableTaskAuthorityReadTeam`](../../../src/adapters/durable-task-authority-read-team.ts#L6) resolves the Team binding. Explicit read-only and publishing factories inject the port ([`beads-task-adapter.ts`](../../../src/model-tool-contract/beads-task-adapter.ts#L362); [`index.ts`](../../../extensions/index.ts#L339)). There is no default `BeadsTaskAdapter` authority constructor. This removes raw read/list exports and consumer/default fallbacks while preserving binding errors, raw/model/TUI/error behavior, public contracts, and the generated Task-authority declaration. Independent acceptance from baseline `cb38d9254dd0cccb9e745a8df3edb27f367d852d` passed the selected 28-file/207-test sweep, typecheck, 113-file lane closure (92 fast, 21 exhaustive), agent and tool-result QA, package verification, public and fence checks.

Independent re-verification also accepts the `TaskChangeDelivery` consumer-owned `TaskDeliveryMembershipPort`. [`DurableTaskChangeDeliveryMembership`](../../../src/adapters/durable-task-change-delivery-membership.ts#L5) keeps Team reads and exact-recipient leases outside Task delivery. The delivery requires that port; it resolves the current recipient at start, sends under its exact lease, and writes the acknowledgement entry before durable acknowledgement ([`task-delivery.ts`](../../../src/utils/task-delivery.ts#L878), [`task-delivery.ts`](../../../src/utils/task-delivery.ts#L978), [`task-delivery.ts`](../../../src/utils/task-delivery.ts#L1037)). Pi composition injects it ([`index.ts`](../../../extensions/index.ts#L345); [`pi-team-session-adapter.ts`](../../../extensions/pi-team-session-adapter.ts#L286)). The characterization covers recipient replacement, send/stage/acknowledgement order, failed-send replay, and one acknowledgement ([`task-change-delivery.characterization.test.ts`](../../../src/utils/task-change-delivery.characterization.test.ts)). Stopped migration remains separate.

These are deterministic local and source/harness checks. They do not prove a real Pi process, Beads/Dolt contention, external writers, filesystem watches, OS scheduling, or terminal pixels. Architecture impact is **changed** for internal Task read and delivery ownership; Structurizr remains unchanged.

The current source bundle removes Worker-launch construction from
`DurableModelToolTeamPort`. The façade now consumes an optional injected
`WorkerLaunchBridge`; read-only and nudge-debt use remains available without it,
and `ensureWorker` refuses missing capability before logical Worker mutation.
Implementation Task `semantic-hardening-authorities-92l`, independent test Task
`semantic-hardening-authorities-3cw`, verification Task
`semantic-hardening-authorities-r9i`, and audit Task
`semantic-hardening-authorities-ojq` are closed. Pi Session hook adaptation
remains the final Team seam.

Commit `1686ac1` adds registered characterization for the Pi adapter before
extraction. It anchors already-current Worker and resumed-lead delivery order,
lead refusal and candidate shutdown, delivery/footer cleanup, Worker title
timers, durable `teamCreated` callback order, and callback-failure state.
Characterization Tasks `semantic-hardening-authorities-tl7` and
`semantic-hardening-authorities-ewv`, wording correction Task
`semantic-hardening-authorities-f09`, and independent review Task
`semantic-hardening-authorities-qqa` are closed.

The current source bundle extracts `extensions/pi-team-session-adapter.ts` as
the one mutable Pi Session identity and lifecycle-hook boundary. Index retains
composition, public tool schemas/executors, and leader branch observation. Team
services retain admission, runtime, stop, and shutdown policy. Implementation
Tasks `semantic-hardening-pi-adapter-jqr`,
`semantic-hardening-pi-adapter-40f`, `semantic-hardening-pi-adapter-7l1`, and
`semantic-hardening-pi-adapter-dq0`; independent test Tasks
`semantic-hardening-pi-adapter-1il` and `semantic-hardening-pi-adapter-lxb`;
architecture Task `semantic-hardening-pi-adapter-0zt`; and verification Task
`semantic-hardening-pi-adapter-jwu` and audit/map Task
`semantic-hardening-pi-adapter-r6f` are closed. This source bundle commits the
accepted Pi Session adapter boundary. `PiSessionTeamQueryPort` now owns its
read-only Team coordinates ([`pi-session-team-query.ts`](../../../src/team-authority/pi-session-team-query.ts#L46)), while
`DurablePiSessionTeamQuery` performs Team record reads outside the adapter
([`durable-pi-session-team-query.ts`](../../../src/adapters/durable-pi-session-team-query.ts#L18)). Composition injects the port
([`index.ts`](../../../extensions/index.ts#L347)). This closes the adapter's
direct Team-query target seam; TeamConfig's mixed compatibility registry remains
separate.

Alert authority commit 2 is accepted at `e9f8dad`. The accepted Alert-port
production tree adds Alert-owned consumer ports. `AlertMembershipPort`
provides only a name roster, a current-delivery lease that resolves Membership
IDs inside durable Team adaptation, and exact Session-binding validation.
`AlertPublicationPort` publishes only an accepted Alert after inbox acceptance.
`DurableAlertMembership` and `DurableAlertPublication` implement these ports
outside Alert authority. `extensions/index.ts` composes one explicit
`AlertSender` for leader and Worker Alert tools and injects the same Membership
adapter into direct delivery; no compatibility singleton exists. The rejected
Team-mirroring and `membershipId`-leaking port
forms remain historical corrections, not current design.

Canonical Alert paths remain `src/alert-authority/alerts.ts`, `contracts.ts`,
`inbox-delivery.ts`, `direct-delivery.ts`, and `delivery-contracts.ts`. The old
`src/utils/alerts.ts`, `messaging.ts`, and `message-delivery.ts` paths are
compatibility facades that preserve old signatures. Public tools, schemas,
package exports, persisted
inbox records and filenames, retry, timing, ordering, errors, console behavior,
lock and publication order, and ALERT-004 remain unchanged. The current AST scan
finds 87 production files and 285 unique resolved static local edges, with zero
cycles and zero dynamic imports. Architecture Task n5o recomputed this canonical
map count after the stale 302-edge record. Independent Task
`semantic-hardening-alert-ports-7cc` accepted the clean committed package,
generated declarations, 87/285 graph, public differential, Alert equivalence,
and exhaustive ALERT-004 gates. Focused evidence covers validation without
effects, ordered parallel fan-out, watch/poll and replacement behavior, and
compatibility failure replay.
It does not prove native filesystem watches or locks, OS scheduling, a real Pi
turn, process, fork, Pi Session, or OS restart. No aggregate ran. Preserve
ALERT-004 exactly: accepted delivery can survive publication failure, the outer
result remains unavailable, and retry creates a new Alert identity with duplicate
delivery. Do not add an outbox, operation ID, recovery record, or warning change.

Coordination observation and its nudge boundary are accepted through commit
`b4bf6dee91cf25532cbc33a397167567ba6d347e`.
Slice C makes `CoordinationObservationService` the owner of snapshot and update
observation, pages, hydration, waits, revisions, pending presentation, cached
Task projections, branch lineage, and acknowledgement. It receives explicit
query, durable-store, wait, and projection dependencies. The durable model-tool
facade delegates this algorithm and keeps stable model-tool aliases and default
constructor compatibility. `CoordinationHiddenObservationPort` now owns hidden
projection reads and commits ([`queries.ts`](../../../src/coordination/queries.ts#L68)); its durable adapter remains outside Coordination
([`durable-coordination-hidden-observation.ts`](../../../src/adapters/durable-coordination-hidden-observation.ts#L10)) and composition injects the store
([`index.ts`](../../../extensions/index.ts#L351)). This closes the hidden-
observation Team-query seam. Pi composition constructs the service once.

Slice B query DTOs and three durable authority adapters remain its read boundary,
and liveness remains pure over them. Outputs, cursors, acknowledgement, bounded
waits, and the quiet cadence remain unchanged: one complete Task read by 4,999
ms and three by 5,000 ms. Do not extract nudge actuation or the Trio facade yet.
The accepted nudge selection moves debt calculation, exact debt identity,
event pagination, neutral Task-projection revision, and failed-hint provenance
into Coordination. Its durable record adapters own JSONL reservation and
promotion storage. `SyncNudgeConductor` owns timers only. Pi alone revalidates
the exact Team epoch, lead Membership, Session, and full branch, reserves,
sends the unchanged custom message, proves that exact persisted message, and
then promotes the record. With logical Workers, missing optional policy version
remains eligible with legacy undefined interpolation. The nudge-specific outer
resolver avoids an early `none` or no-active-Team result, but its durable
hidden-observation read still applies `teamModelToolContractGap`; absent logical
Workers therefore returns the exact legacy unavailable result. Snapshot and
update observation also require logical Workers. The source graph has 99 production
TypeScript files and 334 unique resolved static local edges, with zero
nontrivial cycles or runtime dynamic imports. Test-hardening commit
`3b265ea6fbdc53c9b753950a4ed01ccddad527d8` corrected the registered
characterization to use canonical Alert delivery. That established test exposed
a pre-existing terminal-refusal defect. Intentional behavior-fix commit
`cafdf2deb4ccdbb47cb40b87e83081d1c9128665` keeps resumed foreign or nested
Worker and lead Sessions alive and unbound after placement refusal. Launch or
runtime refusals with `exitProcess=true` still shut down. The exact anchors are
`pi-session-adapter.characterization.test.ts` cases “keeps a resumed Worker
alive when foreign placement refuses its Team binding” and “keeps a resumed
lead alive when foreign placement refuses its Team binding”, plus the nested
Worker and foreign-lead cases in `terminal-backend.contract.test.ts`. Evidence
from the original checkout is invalid for these commits and must not support
this claim. These deterministic hook tests do not prove a real process,
terminal, or terminal carrier. No public tool, schema, persistence, or graph
change occurred; architecture impact is **none** for this fix. The remaining
next boundary is the combined Trio façade and fake, not nudge actuation.

Characterization Tasks `semantic-hardening-coordination-qjp`,
`semantic-hardening-coordination-3bq`, and
`semantic-hardening-coordination-trt` remain the behavior gates. A forwarding
shell and a partial-worker continuity approach were rejected: the accepted
service owns the complete observation state and the existing facade delegates.
Evidence remains one-process deterministic harness evidence, not proof of real
Pi persistence, cross-process forks, native watchers, OS timing, or terminal
pixels.

## Decisions and constraints still in force

- Preserve observable behavior by default. A behavior change needs a separate
  owner decision, historical evidence, normative replacement test, and commit.
- Keep Team, Task, Alert, Coordination, Trio, Membership observation, Session,
  process, pane, delivery, and runtime evidence distinct.
- Keep public tools, schemas, package exports, observation protocol, persisted
  records, filenames, compatibility readers, retry, timing, and defaults stable
  during structural refactoring.
- Assigned Tasks remain the sole durable delegation protocol. Alerts remain
  exceptional coordination and never mutate Task state.
- Consumer-owned cross-authority ports are implemented outside the consuming
  authority. Do not relocate concrete imports into a nominal authority adapter.
- Workers do not commit. The leader integrates stable Tasks and commits the
  exact selected tree.
- Run focused tests during iteration. Reserve one broad aggregate run for the
  exact stable release-candidate tree.
- Do not add a dependency, outbox, service, or general framework without one
  named behavior or measurement that requires it.
- Preserve raw observations and historical records. Derived liveness, failed-
  event hints, nudge debt, and presentation records never become Team, Task, or
  Alert authority.

## Current gates and risks

Closed gates:

- `TASK-RECONCILIATION-INJECTION` — injected Task-owned query with deterministic
  equivalence and import-direction evidence.
- `TASK-PUBLICATION-INVERSION` — consumer-owned port, external durable adapter,
  leader and Worker composition, exact order, warning, failure, no-op, replay,
  and import-fence evidence.
- `BEHAVIOR-CHARACTERIZATION` — all 27 inventory entries have bounded executable
  anchors and explicit proof limits. Broad Trio checks cover 48 registered-tool
  cases; representative TUI outcomes have independent semantic assertions.

Open boundary risks:

- `ALERT-PUBLICATION-FAILURE` / ALERT-004 is compatibility-required for this
  behavior-identical refactor. One-process hook simulation proves later exact-
  Session presentation and replay after an error, not process, fork, Pi Session,
  or OS restart. Any semantic change needs a separate owner-visible decision.
- Coordination implements rc.10 hydration, liveness, failed hints, bounded
  waits, indeterminate outcomes, and nudges. Coordination owns nudge debt,
  identity, pagination, and eligibility; durable record adapters retain nudge
  storage, the conductor owns timers only, and Pi retains exact-Session
  actuation and proof. Pi composition and the hidden-observation Team
  configuration read remain later seams.
- Team lifecycle policy is in Team services, Worker-launch capability is
  injected, and one Pi Session adapter owns hook/refusal/delivery/title/footer/
  nudge integration. Its direct Team record reads remain a narrow integration
  seam. The completed public Membership projection reads only its narrow
  Team/runtime reader and remains non-authoritative.
- Beads hydration has a measured latency tail. Removing reverse-dependent
  hydration, filtering closed Tasks, or raising the timeout would change current
  meaning or policy. Actual optimization remains deferred.

These risks bound future work. They do not show a regression in `15e707b`, and
they do not authorize speculative completion before the next release candidate.

## Herdr recovery

Herdr is an exceptional terminal recovery surface, not Team or Task authority.
Require `HERDR_ENV=1`. Query with `herdr agent list`, then use `agent get` and
`agent read --source recent-unwrapped` for the exact agent. Never rely on UI
focus or stale pane IDs.

The direct leader is named `ptb-semantic-direct-leader`; the independent
watchdog is `ptb-full-split-watchdog`. The watchdog checks every 600 seconds and
requires two full quiet intervals with no agent, terminal, Task, Git, context,
or journal progress before it treats a turn as stuck. It also checks every
completion gate in this document and refuses early completion. `unknown` is
uncertainty.

For a proven stuck turn, read the pane, send one Escape, wait, and resume the
exact coordinator Session only after process absence is proven. Start through
`_codex_with_proxy` with `openai-codex/gpt-5.6-terra:medium` in the same pane.
Use `agent prompt` for recognized agents and `pane run` only for shell commands.
Do not move, close, or focus unrelated panes, and never stop the Herdr server for
this Project. Normal coordination remains Task-first through `team_sync`.

## Next actions

1. Keep verified source `bea6f45572ba34f5e29574cc489f45383b7ebc19`
   stable. Route later structural or behavior changes through new focused gates.
2. Keep the accepted Trio, Membership, Alert, Task read/delivery/provisioning,
   Coordination event-journal, TeamConfig, and nudge boundaries stable.
3. Treat measured Beads hydration and aggregate resource contention as deferred
   non-functional work. Do not change product timeouts without a separate decision.
4. Keep tag, main-branch integration, npm publication, provenance, and GitHub
   release outside this continuation unless the owner authorizes them.
