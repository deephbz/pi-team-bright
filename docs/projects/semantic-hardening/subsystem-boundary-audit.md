# Accepted subsystem boundary audit

Date: 2026-08-09
Status: maintained rc.10 audit; Task reconciliation, Task mutation publication,
and Team lead-discovery ownership are implemented and independently verified;
the other subsystem migrations remain incomplete
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

## Scope and evidence

This audit uses the five accepted subsystems in the Project handoff: Team
authority and Role realization, Task authority, Alert authority, Coordination
observation, and Trio-facing interface and projections. Public Membership
observation remains an additive machine projection of Team authority.

The initial review covered 60 production TypeScript files with 18,145 lines and
77 test or test-support files with 20,585 lines. The verified Task publication
tree has 68 production TypeScript files with 19,559 lines, plus 88 test files
with 23,647 lines and two test-support files with 441 lines. The 90 test and
support files contain 24,088 lines combined.
The lane manifest assigns 67 test files to fast and 21 to exhaustive. Production
means tracked or selected `.ts` files under `src/` and `extensions/`, excluding
`*.test.ts`; test support means `test/setup.ts` and non-test
`test/support/*.ts`, while runner-only global setup is excluded. A
TypeScript-AST scan resolves static relative import and re-export specifiers
between those production files. It finds 231 unique local edges, no nontrivial
strongly connected component, no self-cycle, and no dynamic import. The prior
hidden dynamic Task-adapter cycle remains removed, and the Task mutation path no
longer imports concrete publication writers.

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
`worker-launch-bridge.ts`, `worker-resource-projection.ts`, `session-terminal.ts`,
`team-terminal.ts`, terminal adapters, and lifecycle code in
`extensions/index.ts`. One current Membership admits one live process generation
(`src/utils/runtime.ts:78`). `WorkerLaunchBridge.ensureWorker` plans reuse,
first-binding retry, or exact-Session recovery before carrier creation
(`src/utils/worker-launch-bridge.ts:132`). The extension performs startup
admission, runtime claim, Session bind, event publication, stop, and shutdown
(`extensions/index.ts:832`, `extensions/index.ts:1243`). Durable lead-Session
discovery now lives in `findLeadTeamForSession` (`src/utils/teams.ts:476`); the
extension calls that query without changing environment precedence or hook
timing.

Team compatibility is not isolated. `TeamConfig` also carries resolved sync-
liveness policy, historical implementation provenance, Beads authority,
workspace, fingerprint, and Task-cutover fields (`src/utils/models.ts:61`).
`createTeam` captures sync-liveness settings once for the Team epoch
(`src/model-tool-contract/durable-model-tool-port.ts:204`,
`src/model-tool-contract/durable-model-tool-port.ts:239`), while current
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
injects it into `TaskChangeDelivery` (`extensions/index.ts:791`).
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
(`extensions/index.ts:406`, `extensions/index.ts:435`,
`extensions/index.ts:1328`). Default `BeadsTaskAdapter` construction remains
read-only (`src/model-tool-contract/beads-task-adapter.ts:384`).

`task-delivery.ts` currently owns Task-delivery meaning: exact recipient intent,
precommit owner-transition markers, committed projections, recovery records,
tombstones, presentation attempts, and successful-turn acknowledgement
(`src/utils/task-delivery.ts:45`, `src/utils/task-delivery.ts:340`,
`src/utils/task-delivery.ts:824`). Session steer is actuation only. A successful
turn acknowledges presentation but never mutates Task state
(`src/utils/task-delivery.ts:950`). The current causal inventory maps assignment,
exact-Session presentation, acknowledgement, and leader observation
(`src/utils/causal-path.inventory.json`).

Task and delivery migration remain stopped-epoch compatibility paths in
`task-migration.ts` and `task-delivery-migration.ts`. Normal delivery refuses
noncanonical records with an explicit migration requirement
(`src/utils/task-delivery.ts:671`). `in-memory-team-port.ts` temporarily
re-exports `ModelToolTaskUpdateInput` and `ModelToolTaskJournalEntry` from the
Task-owned contract module, so existing internal imports remain compatible.

### Alert authority

`alerts.ts` owns Alert kinds, target rules, Task references, acceptance, fan-out,
and the invariant that Alerts do not mutate Tasks (`src/utils/alerts.ts:6`,
`src/utils/alerts.ts:37`). It uses the legacy Message inbox as its durable
delivery queue through `messaging.ts`, then uses `DirectMessageDelivery` for
exact-Membership Session presentation and successful-turn acknowledgement
(`src/utils/alerts.ts:99`, `src/utils/message-delivery.ts:259`).

The Message names are now implementation vocabulary. Public work uses typed
Alerts, but records remain `InboxMessage` and the actuator identifies itself as
`pi-teams-message/2` (`src/utils/models.ts:149`,
`src/utils/message-delivery.ts:15`). This is a naming and ownership leak, not
evidence for a sixth Message subsystem.

### Coordination observation

`team-events.ts` owns the append-only event journal, monotonic cursors, bounded
pages, check-register-check waits, and snapshot projection helpers. It appends
only after an owning authority commits (`src/utils/team-events.ts:278`). Its
page cursor is the last represented event rather than the unseen journal head
(`src/utils/team-events.ts:323`), and filesystem notifications remain hints; the
post-registration read closes the lost-wakeup gap
(`src/utils/team-events.ts:424`).

`hidden-observation.ts` owns acknowledged branch position. It keys state by Team
epoch and exact lead Session, validates branch lineage, and commits only after
Pi persists the exact result entry (`src/utils/hidden-observation.ts:169`,
`src/utils/hidden-observation.ts:208`). `DurableModelToolTeamPort.readTeamSync`
now composes page-safe event reads, event-directed Task hydration, complete
quiet-journal rescans, exact cached baselines, Worker run-state and actuation
evidence, configured bounded waits, projection hashes, failed-event hint
cursors, and pending acknowledgement
(`src/model-tool-contract/durable-model-tool-port.ts:435`). It returns
`indeterminate` without position advance when run-state evidence cannot prove a
productive or complete wait (`src/model-tool-contract/durable-model-tool-port.ts:513`).

The rc.9/rc.10 additions remain spread across current modules.
`sync-liveness.ts` derives `active`, `settled`, `unknown`, or `absent` from exact
runtime generation plus pending Task and Alert/Message actuation, and
`waitForLivenessHint` watches event/runtime hints while periodically rechecking
Task authority (`src/utils/sync-liveness.ts:27`,
`src/utils/sync-liveness.ts:87`). `task-event-failure-hints.ts` stores
payload-light derived evidence when Task state commits but its Team event does
not; Coordination matches only the current epoch, Task identity, and version
(`src/utils/task-event-failure-hints.ts:115`,
`src/utils/task-event-failure-hints.ts:165`). `readSyncNudgeDebt` derives branch-
bound reconciliation debt, while `SyncNudgeConductor` and the Pi composition
root reserve, validate, present, and persist delayed nudges only after exact
Session-branch evidence (`src/model-tool-contract/durable-model-tool-port.ts:605`,
`src/utils/sync-nudge-conductor.ts:27`, `extensions/index.ts:634`). These derived
records and timers never become Team, Task, or observation authority.

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
schemas and execution beside the leader journey (`extensions/index.ts:1293`).
`team-status.ts` and `team-footer.ts` are human projections, but they import Team
and Task implementations directly (`src/utils/team-status.ts:4`,
`src/utils/team-status.ts:6`, `src/utils/team-footer.ts:9`).

### Additive Membership observation

`src/public/observation.ts` is one-way: no core production module imports it. It
locklessly reads atomic Team/runtime records, applies deadline and abort
controls, and emits only `pi-teams-observation/1`
(`src/public/observation.ts:8`, `src/public/observation.ts:139`). It is not a core subsystem. Its direct use of
broad internal `Member` and runtime types makes public compatibility sensitive
to private record changes (`src/public/observation.ts:5`).

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
   (`src/utils/task-delivery.ts:18`, `extensions/index.ts:791`). The production
   static file graph remains acyclic. Task mutation now uses the injected
   publication port, so reconciliation and publication dependencies both point
   through explicit seams.

4. `ModelToolTeamPort` combines Team, Task, Alert, Coordination, launch context,
   sync-nudge debt, and observation acknowledgement in one interface
   (`src/model-tool-contract/in-memory-team-port.ts:162`). Its in-memory
   implementation stores Team state, Task state, replay records, event history,
   branch baselines, pending observations, and waiters in one `StoredTeam` and
   class (`src/model-tool-contract/in-memory-team-port.ts:209`,
   `src/model-tool-contract/in-memory-team-port.ts:273`). This test seam can make
   cross-authority atomicity appear easier than the durable system.

5. `DurableModelToolTeamPort` has 21 unique direct local production dependencies.
   It directly constructs Task, Team, Alert, Coordination, liveness, failed-
   event-hint, nudge-debt, and Worker-launch behavior
   (`src/model-tool-contract/durable-model-tool-port.ts:1`). Its five process
   maps hold Session files, launch context, branch lineage, pending observations,
   and exact acknowledged Task projections
   (`src/model-tool-contract/durable-model-tool-port.ts:132`). It is a useful
   façade, not one subsystem port.

6. **Resolved for durable lead discovery.** `extensions/index.ts` delegates
   durable lead-Session discovery to Team authority. It still owns lifecycle
   application services, starts two delivery engines, composes sync-nudge
   reservation and exact-branch presentation, and wires trio projection
   (`extensions/index.ts:634`). Pi hook order is therefore an implicit
   integration contract.

7. `models.ts` and `paths.ts` act as shared registries. `models.ts` mixes Team,
   runtime carrier, Task relation, Coordination event, sync-liveness policy,
   Alert, and delivery Message types (`src/utils/models.ts:15`,
   `src/utils/models.ts:61`, `src/utils/models.ts:105`,
   `src/utils/models.ts:114`, `src/utils/models.ts:149`). `paths.ts` exposes
   every authority's private and derived records through one support module
   (`src/utils/paths.ts:26`, `src/utils/paths.ts:34`,
   `src/utils/paths.ts:39`, `src/utils/paths.ts:59`,
   `src/utils/paths.ts:69`, `src/utils/paths.ts:86`). Paths own no truth, but the mixed type file
   does.

8. Alert authority depends on broad Message storage and directly publishes a
   Coordination event (`src/utils/alerts.ts:1`). Delivery acceptance happens
   before event append (`src/utils/alerts.ts:109`, `src/utils/alerts.ts:137`).
   Tests prove this order, partial fan-out, and an event-append failure after
   partial accepted delivery (`src/utils/alerts.test.ts:32`,
   `src/utils/alerts.test.ts:87`,
   `src/utils/alert-publication-failure.characterization.test.ts`). Independent
   verification accepted the failure case as characterization. ALERT-004 remains
   unclassified; recovery ownership and behavior classification authorize no
   change.

9. Team lifecycle and Task authority need queries in both directions. Worker
   stop checks nonterminal Tasks while holding the Team topology lease
   (`extensions/index.ts:1246`, `extensions/index.ts:1251`), while Task creation
   validates a logical Worker
   (`src/model-tool-contract/durable-model-tool-port.ts:305`). Consumer-owned
   query ports must prevent this semantic relation from becoming a source cycle.

10. Coordination liveness currently reads Team runtime, Task delivery, and the
    Alert/Message inbox directly (`src/utils/sync-liveness.ts:1`). This is useful
    read-only evidence, but its source dependency crosses three accepted
    boundaries. Future isolation needs consumer-owned read ports; the derived
    `WorkerRunObservation` must not become another authority.

11. Public Membership observation is core-independent, but it reads private
    record shapes directly. A narrow Team-observation record reader would keep
    it additive and reduce public compatibility blast radius.

## Risks and unresolved test gates

- `ALERT-PUBLICATION-FAILURE` is open for owner classification. Alert delivery
  records can be accepted before `appendTeamEvent` fails
  (`src/utils/alerts.ts:109`, `src/utils/alerts.ts:137`). Independently verified
  characterization records an ambiguous unavailable
  result, retained native delivery, duplicate delivery after retry, unchanged
  Task state, and no event for the first Alert
  (`src/utils/alert-publication-failure.characterization.test.ts`). Restart and
  later-presentation evidence also remain open. The Alert boundary must not
  choose preservation, warnings, recovery records, or an outbox until the owner
  classifies this behavior.
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

- The rc.10 Coordination additions have focused settings, liveness, hydration,
  failed-event-hint, nudge, extension, and E2E evidence. They preserve explicit
  `indeterminate` outcomes and branch-safe position, but they do not prove a
  separated Coordination application port or remove cross-authority read
  dependencies.

The upward Task-to-trio type risk, hidden dynamic reconciliation cycle, and
concrete Task publication dependencies are closed, and durable lead discovery
now belongs to Team authority. The main remaining structural risks are one
façade and one in-memory fake that combine all authorities, Coordination
liveness reading three authorities, hook-order coupling in the Pi composition
root, and public Membership observation reading broad private records. These risks do not authorize behavior changes.

## Preserved state, timing, and ordering facts

- Team lock order is topology to Membership to TeamConfig. Membership leases
  remain held across slow Task writes so replacement or shutdown cannot pass a
  stale actor (`src/utils/teams.ts:791`, `src/utils/teams.ts:811`).
- New Worker order is resource validation, Membership prepare, prepared event,
  terminal spawn, carrier binding, then bounded startup observation
  (`src/utils/worker-launch-bridge.ts:132`). Compensation deactivates only after
  exact carrier-stop proof (`src/utils/worker-launch-bridge.ts:475`).
- Process startup order is runtime-generation claim, Membership Session bind,
  then `session_bound` event (`extensions/index.ts:909`,
  `extensions/index.ts:912`, `extensions/index.ts:915`). A post-claim failure
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
  `src/utils/message-delivery.ts:365`). Restart replays presented but
  unacknowledged records. Concurrent test changes now characterize aborted
  turns and failed Session sends (`src/utils/delivery-round3.test.ts`).
- A Team epoch captures its sync wait and nudge policy once. The wait defaults to
  120 seconds and settings bound it from zero through 3,600 seconds
  (`src/utils/sync-liveness-settings.ts:6`,
  `src/utils/sync-liveness-settings.ts:8`,
  `src/model-tool-contract/durable-model-tool-port.ts:204`,
  `src/model-tool-contract/durable-model-tool-port.ts:239`). `team_sync` must
  publish one complete observation or none; `indeterminate` does not advance
  position, and hidden state advances only after the exact result persists on
  the active branch (`src/model-tool-contract/durable-model-tool-port.ts:513`,
  `extensions/index.ts:475`).
- Runtime constants of 90 seconds for heartbeat staleness, 60 seconds for
  startup stall, and five minutes for stale files are diagnostic policy, not
  work state (`src/utils/runtime.ts:11`, `src/utils/runtime.ts:12`,
  `src/utils/runtime.ts:13`). Membership observation has a separate
  one-second default deadline (`src/public/observation.ts:105`). Coordination
  run state uses exact generation and actuation evidence instead of heartbeat or
  terminal activity (`src/utils/sync-liveness.ts:27`).
- Alert fan-out is per-recipient and partial. Accepted inbox writes precede one
  combined Alert event (`src/utils/alerts.ts:109`, `src/utils/alerts.ts:137`).
- Sync nudges reserve before send and become presented evidence only after the
  exact custom message exists on the same full branch lineage
  (`src/utils/sync-nudge.ts:47`, `extensions/index.ts:690`,
  `extensions/index.ts:697`). They request
  reconciliation and never mutate Task or Team authority.
- Compatibility readers preserve legacy Memberships, inbox IDs, terminal
  fields, Task cutover evidence, and mixed event/delivery records.

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
5. Isolate Alert next. Wrap Message inbox records as an Alert delivery adapter
   without changing filenames or schemas. Inject Team membership and
   coordination publication. Characterize accepted-delivery/event-failure
   behavior before deciding whether Alert needs an outbox.
6. Consolidate the current rc.10 Coordination behavior behind one application
   boundary: page-safe `team_sync`, event-directed hydration, complete quiet-
   journal rescans, liveness and actuation reads, failed-event hints, nudge debt,
   projection hashes, and hidden acknowledgement. It must read Team, Task, and
   Alert state through consumer-owned query ports; derived hints and timers stay
   non-authoritative, and authorities no longer import `team-events.ts`
   concretely.
7. **Partly implemented.** Durable lead-Session discovery moved verbatim into
   Team authority. Extract the remaining Team Session lifecycle and Worker
   carrier services from `extensions/index.ts`. Keep exact hook order in one
   small Pi adapter. Team authority retains resource resolution, startup,
   recovery, stop, shutdown, and compatibility policy.
8. Keep result and TUI projection, catalog schemas, and Pi registration above
   the semantic application ports. Make status and footer consume query DTOs.
9. Give public Membership observation a narrow read-only Team/runtime decoder.
   Keep its export and schema unchanged. Add an import fence that prevents core
   modules from importing it.
10. Add static dependency tests after each seam moves. Preserve the outside-in
    characterization suite after each step. Do not start with a directory rename
    or whole-system rewrite.

`TASK-RECONCILIATION-INJECTION` and `TASK-PUBLICATION-INVERSION` now prove the
implemented Task dependency boundaries. They remove the clearest upward type
dependency, hidden dynamic reconciliation cycle, and concrete mutation-
publication writers without changing a public operation, persisted record, or
runtime order. The rebased rc.10 tree adds substantial Coordination behavior and
evidence, but it does not complete Team, Alert, Coordination, Trio, or additive
Membership-observation boundaries. ALERT-004 remains unclassified; owner
classification plus restart and later-presentation evidence remain required
before Alert refactoring.
