# Accepted subsystem boundary audit

Date: 2026-08-09
Status: source and test audit; no production change
Reviewed source revision: `ed7ae5710f77352741f2b20be823d9c59941f784`
Production TypeScript baseline: `e55b4f2a9190d700a03d95cb9dee75e5c892ca0a`
(no production TypeScript changed through the reviewed revision)
Architecture impact of this audit: **none**

## Scope and evidence

This audit uses the five accepted subsystems in the Project handoff: Team
authority and Role realization, Task authority, Alert authority, Coordination
observation, and Trio-facing interface and projections. Public Membership
observation remains an additive machine projection of Team authority.

The review covered 60 production TypeScript files with 18,145 lines. It also
covered 77 current test and test-support files with 20,585 lines, plus the
scripts, benchmarks, and test configuration. This includes the committed
causal-path characterization and external test harness. A TypeScript-AST scan
found 204 unique local static imports between production files and no static
strongly connected component. Dynamic imports and broad composition modules
still hide semantic cycles. Phase-two branch-observation and Alert-publication
characterizations were not part of the reviewed production revision. Independent
verification accepted them as current-behavior evidence, not as intended or
normative contracts. The machine-operable
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
TeamConfig compatibility. It states the lock order as Team topology, exact
Membership, then TeamConfig (`src/utils/teams.ts:223`). Team recreation keeps
historical Memberships and creates a new epoch only after all current
Memberships end (`src/utils/teams.ts:261`). Exact teammate resolution scans and
then revalidates the selected Membership under its mutation lease
(`src/utils/teams.ts:588`).

Runtime and Role realization is spread across `runtime.ts`,
`worker-launch-bridge.ts`, `worker-resource-projection.ts`, `session-terminal.ts`,
`team-terminal.ts`, terminal adapters, and lifecycle code in
`extensions/index.ts`. One current Membership admits one live process generation
(`src/utils/runtime.ts:55`). Worker launch plans reuse, first-binding retry, or
exact-Session recovery before carrier creation (`src/utils/worker-launch-bridge.ts:132`).
The extension performs startup admission, runtime claim, Session bind, event
publication, stop, and shutdown (`extensions/index.ts:802`,
`extensions/index.ts:1099`).

Team compatibility is not isolated. `TeamConfig` also carries Beads authority,
workspace, fingerprint, and Task-cutover fields (`src/utils/models.ts:53`).
`teams.ts` validates and preserves them during Team recreation
(`src/utils/teams.ts:307`). This is required current compatibility behavior, but
it makes TeamConfig a shared persistence envelope instead of a narrow Team
contract.

### Task authority

The canonical Task contract is `task-domain.ts` plus `task-version-ref.ts`.
`BeadsTaskAdapter` owns metadata parsing, bounded TaskCard projection, opaque
versions, replay, CAS, and semantic outcomes
(`src/model-tool-contract/beads-task-adapter.ts:184`,
`src/model-tool-contract/beads-task-adapter.ts:355`). `BeadsTaskStore` owns native
CLI records and mutations. `beads-authority-adapter.ts` combines Team-scoped
authority resolution, exact actor fencing, semantic mutation, coordination
publication, and Task-delivery publication.

`task-delivery.ts` currently owns Task-delivery meaning: exact recipient intent,
precommit owner-transition markers, committed projections, recovery records,
tombstones, presentation attempts, and successful-turn acknowledgement
(`src/utils/task-delivery.ts:44`, `src/utils/task-delivery.ts:338`,
`src/utils/task-delivery.ts:817`). Session steer is actuation only. A successful
turn acknowledges presentation but never mutates Task state
(`src/utils/task-delivery.ts:937`). The current causal inventory maps assignment,
exact-Session presentation, acknowledgement, and leader observation
(`src/utils/causal-path.inventory.json`).

Task and delivery migration remain stopped-epoch compatibility paths in
`task-migration.ts` and `task-delivery-migration.ts`. Normal delivery refuses
noncanonical records with an explicit migration requirement
(`src/utils/task-delivery.ts:664`).

### Alert authority

`alerts.ts` owns Alert kinds, target rules, Task references, acceptance, fan-out,
and the invariant that Alerts do not mutate Tasks (`src/utils/alerts.ts:5`,
`src/utils/alerts.ts:37`). It uses the legacy Message inbox as its durable
delivery queue through `messaging.ts`, then uses `DirectMessageDelivery` for
exact-Membership Session presentation and successful-turn acknowledgement
(`src/utils/alerts.ts:99`, `src/utils/message-delivery.ts:235`).

The Message names are now implementation vocabulary. Public work uses typed
Alerts, but records remain `InboxMessage` and the actuator identifies itself as
`pi-teams-message/2` (`src/utils/models.ts:149`,
`src/utils/message-delivery.ts:15`). This is a naming and ownership leak, not
evidence for a sixth Message subsystem.

### Coordination observation

`team-events.ts` owns the append-only event journal, monotonic cursors, bounded
pages, check-register-check waits, snapshot projection helpers, and Task
hydration selection. It appends only after an owning authority commits
(`src/utils/team-events.ts:274`). Filesystem notifications are hints; the final
read closes the lost-wakeup gap (`src/utils/team-events.ts:364`).

`hidden-observation.ts` owns acknowledged branch position. It keys state by Team
epoch and exact lead Session, validates branch lineage, and commits only after
Pi persists the exact result entry (`src/utils/hidden-observation.ts:148`,
`src/utils/hidden-observation.ts:194`).
`DurableModelToolTeamPort.readTeamSync` composes event reads, waits, current Task
hydration, projection hashes, and pending acknowledgement
(`src/model-tool-contract/durable-model-tool-port.ts:395`).

Worker startup observation consumes coordination events, but it verifies current
Team and runtime authority before claiming success. Its three-second wait is
bounded launch evidence, not Worker readiness or progress
(`src/utils/worker-startup-observation.ts:5`,
`src/utils/worker-startup-observation.ts:42`).

### Trio-facing interface and projections

`catalog.ts` owns public input and raw-result schemas. `pi-registration.ts`
registers the ten operations. `executors.ts` maps calls to the current port.
`result-projection.ts` validates raw machine details and derives concise model
JSON. `tui-projection.ts` derives collapsed and expanded human views.
`assembleToolResult` preserves raw semantic details as machine truth and
serializes the validated model view separately
(`src/model-tool-contract/result-projection.ts:361`).

`extensions/index.ts` is both the Pi composition root and a second application
layer. Its process closure holds role, Team, Membership, delivery, tool, footer,
and model caches (`extensions/index.ts:371`). It also contains Worker schemas
and execution beside the leader journey (`extensions/index.ts:1165`).
`team-status.ts` and `team-footer.ts` are human projections, but they import Team
and Task implementations directly (`src/utils/team-status.ts:3`,
`src/utils/team-footer.ts:6`).

### Additive Membership observation

`src/public/observation.ts` is one-way: no core production module imports it. It locklessly reads atomic Team/runtime records, applies deadline
and abort controls, and emits only `pi-teams-observation/1`
(`src/public/observation.ts:138`). It is not a core subsystem. Its direct use of
broad internal `Member` and runtime types makes public compatibility sensitive
to private record changes (`src/public/observation.ts:5`).

## Boundary assessments

1. The clearest upward dependency is Task authority importing trio-facing
   types. `beads-task-adapter.ts` imports `ModelToolTaskUpdateInput` and journal
   types from `in-memory-team-port.ts`
   (`src/model-tool-contract/beads-task-adapter.ts:25`). Canonical Task commands
   therefore depend on a model-tool test double.

2. The Task publication path directly imports Coordination and Team authority.
   `beads-authority-adapter.ts` imports Team/session leases,
   `appendTaskEvidenceEvent`, and Task delivery
   (`src/model-tool-contract/beads-authority-adapter.ts:4`). This module owns the
   causal transaction boundary, but concrete imports prevent independent fault
   seams.

3. A semantic Task cycle is hidden by dynamic imports. Task mutation imports
   `task-delivery.ts`, while Task-delivery reconciliation dynamically imports
   both Task adapters (`src/utils/task-delivery.ts:459`,
   `src/utils/task-delivery.ts:545`). The static graph has no SCC only because
   the cycle is deferred to runtime.

4. `ModelToolTeamPort` combines Team, Task, Alert, Coordination, launch context,
   and observation acknowledgement in one interface
   (`src/model-tool-contract/in-memory-team-port.ts:168`). Its in-memory
   implementation stores Team state, Task state, replay records, event history,
   branch baselines, pending observations, and waiters in one `StoredTeam` and
   class (`src/model-tool-contract/in-memory-team-port.ts:214`,
   `src/model-tool-contract/in-memory-team-port.ts:278`). This test seam can make
   cross-authority atomicity appear easier than the durable system.

5. `DurableModelToolTeamPort` has 16 direct production dependencies. It directly
   constructs Task, Team, Alert, Coordination, and Worker-launch behavior
   (`src/model-tool-contract/durable-model-tool-port.ts:1`). Its four process
   maps hold Session files, launch context, branch lineage, and pending
   observations (`src/model-tool-contract/durable-model-tool-port.ts:111`). It
   is a useful façade, not one subsystem port.

6. `extensions/index.ts` has 27 direct production dependencies. It duplicates
   lead binding discovery instead of only using Team authority
   (`extensions/index.ts:238`), owns lifecycle application services, starts two
   delivery engines, and wires trio projection. Pi hook order is therefore an
   implicit integration contract.

7. `models.ts` and `paths.ts` act as shared registries. `models.ts` mixes Team,
   runtime carrier, Task relation, coordination event, Alert, and delivery
   Message types (`src/utils/models.ts:13`). `paths.ts` exposes every
   authority's private records through one support module
   (`src/utils/paths.ts:25`). Paths own no truth, but the mixed type file does.

8. Alert authority depends on broad Message storage and directly publishes a
   Coordination event (`src/utils/alerts.ts:1`). Delivery acceptance happens
   before event append. Tests prove this order, partial fan-out, and an
   event-append failure after partial accepted delivery
   (`src/utils/alerts.test.ts:32`, `src/utils/alerts.test.ts:87`,
   `src/utils/alert-publication-failure.characterization.test.ts`). Independent
   verification accepted the failure case as characterization. Recovery
   ownership and behavior classification remain open; it authorizes no change.

9. Team lifecycle and Task authority need queries in both directions. Worker
   stop checks nonterminal Tasks while holding the Team topology lease
   (`extensions/index.ts:1131`), while Task creation validates a logical Worker
   (`src/model-tool-contract/durable-model-tool-port.ts:258`). Consumer-owned
   query ports must prevent this semantic relation from becoming a source cycle.

10. Public Membership observation is core-independent, but it reads private
    record shapes directly. A narrow Team-observation record reader would keep
    it additive and reduce public compatibility blast radius.

## Risks and unresolved test gates

- `ALERT-PUBLICATION-FAILURE` is open for owner classification. Alert delivery
  records can be accepted before `appendTeamEvent` fails (`src/utils/alerts.ts:99`).
  Independently verified characterization records an ambiguous unavailable
  result, retained native delivery, duplicate delivery after retry, unchanged
  Task state, and no event for the first Alert
  (`src/utils/alert-publication-failure.characterization.test.ts`). Restart and
  later-presentation evidence also remain open. The Alert boundary must not
  choose preservation, warnings, recovery records, or an outbox until the owner
  classifies this behavior.
- `TASK-RECONCILIATION-INJECTION` is open. Existing tests anchor
  self-authored suppression, later external changes, owner-transition recovery,
  and concurrent recipient deduplication (`src/utils/clean-cut-round2.test.ts:157`,
  `src/utils/owner-transition-outbox.contract.test.ts:66`). Before replacing
  the dynamic adapter imports in `reconcileTaskChanges`, run those cases through
  the proposed injected Task query and prove identical records, warnings, and
  refusal behavior. The proposed dependency inversion is not itself evidence
  of equivalence.

The main structural risks are upward Task-to-trio type ownership, one façade and
one in-memory fake that combine all authorities, hook-order coupling in the Pi
composition root, and public Membership observation reading broad private
records. These risks do not authorize behavior changes.

## Preserved state, timing, and ordering facts

- Team lock order is topology to Membership to TeamConfig. Membership leases
  remain held across slow Task writes so replacement or shutdown cannot pass a
  stale actor (`src/utils/teams.ts:775`).
- New Worker order is resource validation, Membership prepare, prepared event,
  terminal spawn, carrier binding, then bounded startup observation
  (`src/utils/worker-launch-bridge.ts:132`). Compensation deactivates only after
  exact carrier-stop proof (`src/utils/worker-launch-bridge.ts:372`).
- Process startup order is runtime-generation claim, Membership Session bind,
  then `session_bound` event (`extensions/index.ts:819`). A post-claim failure
  deliberately leaves a runtime fence until PID exit.
- Normal Task mutation commits Beads first, appends event evidence, then enqueues
  delivery. Event and delivery failures produce degraded warnings and do not
  roll back Task state (`src/model-tool-contract/beads-authority-adapter.ts:500`).
- Assignee changes first prepare delivery intent, then embed its operation ID in
  the Beads mutation, mark it committed, and dispatch exact recipients
  (`src/utils/task-delivery.ts:338`, `src/utils/task-delivery.ts:414`). Recovery
  trusts only the matching Beads marker (`src/utils/task-delivery.ts:443`).
- Task and Alert presentation use filesystem hints plus 30-second fallback
  scans. Context observation stages IDs. Only a non-error, non-aborted turn
  commits acknowledgement (`src/utils/task-delivery.ts:848`,
  `src/utils/message-delivery.ts:290`). Restart replays presented but
  unacknowledged records. Concurrent test changes now characterize aborted
  turns and failed Session sends (`src/utils/delivery-round3.test.ts`).
- `team_sync` waits up to 120 seconds
  (`src/model-tool-contract/durable-model-tool-port.ts:51`). It must publish one
  complete observation or none and advances hidden state only after the exact
  result persists on the active branch (`extensions/index.ts:470`).
- Runtime constants of 90 seconds for heartbeat staleness, 60 seconds for
  startup stall, and five minutes for stale files are diagnostic policy, not
  work state (`src/utils/runtime.ts:9`). Membership observation has a separate
  one-second default deadline (`src/public/observation.ts:104`).
- Alert fan-out is per-recipient and partial. Accepted inbox writes precede one
  combined Alert event (`src/utils/alerts.ts:109`).
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

1. Move `TaskCard`, `TaskVersionRef`, Task commands, journal entries, and Task
   outcomes to a Task-owned contract directory. Keep temporary re-exports at
   current paths. Remove Task imports from `in-memory-team-port.ts` first.
2. Split `models.ts` into Team, Coordination-event, and Alert-delivery
   contracts. Keep `models.ts` as a compatibility re-export. Do not change
   persisted shapes.
3. Define narrow application interfaces for Team, Task, Alert, and
   Coordination. Make `ModelToolTeamPort` a trio-facing façade. Split the
   in-memory implementation into separate fakes so tests cannot assume one-store
   atomicity.
4. Isolate Task first. Inject current-Membership resolution,
   coordination-event publication, and Session actuation. Keep owner-transition
   intent, recovery, tombstones, and compatibility in Task authority. Replace
   dynamic Task-adapter imports with an injected Task query.
5. Isolate Alert next. Wrap Message inbox records as an Alert delivery adapter
   without changing filenames or schemas. Inject Team membership and
   coordination publication. Characterize accepted-delivery/event-failure
   behavior before deciding whether Alert needs an outbox.
6. Make Coordination own `team_sync` composition, waits, hydration, projection
   hashes, and hidden acknowledgement state. It reads authority query ports;
   authorities no longer import `team-events.ts` concretely.
7. Extract Team Session lifecycle and Worker carrier services from
   `extensions/index.ts`. Keep exact hook order in one small Pi adapter. Team
   authority retains resource resolution, startup, recovery, stop, shutdown,
   and compatibility policy.
8. Keep result and TUI projection, catalog schemas, and Pi registration above
   the semantic application ports. Make status and footer consume query DTOs.
9. Give public Membership observation a narrow read-only Team/runtime decoder.
   Keep its export and schema unchanged. Add an import fence that prevents core
   modules from importing it.
10. Add static dependency tests after each seam moves. Preserve the outside-in
    characterization suite after each step. Do not start with a directory rename
    or whole-system rewrite.

The first proposed seam is Task contract ownership plus an injected Task
reconciliation query. Start it only after `TASK-RECONCILIATION-INJECTION` proves
the current behavior across the new boundary. It can then remove the clearest
upward dependency and hidden dynamic cycle without changing a public operation,
persisted record, or runtime order. Alert event-failure recovery remains the
highest unresolved behavior question. Its characterization passed independent
verification, but owner classification plus restart and later-presentation
evidence remain required before Alert refactoring.
