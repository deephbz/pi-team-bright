# Pi Team Bright evergreen context

Updated: 2026-08-09

Lifecycle stage: **sharing** for the Task-first coordination and Membership-
observation surfaces; the unresolved Beads list-contention path remains in
**hardening**.

This is the maintained context a new human or agent should read first. It
contains only intent, decisions still in force, current status, constraints,
and next steps. Executable contracts live in source and tests; private dated
evidence remains in the repository history rather than the npm artifact.

## Product intent

Pi Team Bright turns one Pi Session into the lead of a Team of stable Workers,
with Task-first teams visible in terminal panes. A Task plus its assignee is
the only executable work contract. `team_sync` is the event-driven observation
and wait boundary. Typed Alerts are exceptional clarification, attention, or
announcement; they never assign, advance, block, or complete work.

The product deliberately excludes a general agent directory, cross-Team
routing, freeform work-by-message, inbox polling, runtime polling as progress,
and terminal activity as Task evidence. Exact current Membership and Pi Session
binding determine who may act; matching names, processes, panes, or environment
variables do not.

## Sources of truth

| Concern | Authority |
|---|---|
| Public tool selection and TUI renderer attachment | [`src/model-tool-contract/result-projection.ts`](../../src/model-tool-contract/result-projection.ts), [`src/model-tool-contract/tui-projection.ts`](../../src/model-tool-contract/tui-projection.ts), and [`extensions/index.ts`](../../extensions/index.ts) |
| Worker-only settings resource projection | [`src/utils/worker-resource-projection.ts`](../../src/utils/worker-resource-projection.ts) and its focused tests |
| Tool parameters, descriptions, guards, and execution | TypeBox registrations in [`extensions/index.ts`](../../extensions/index.ts) |
| Machine result schema | Raw catalog unions and model projection schemas in [`src/model-tool-contract/result-projection.ts`](../../src/model-tool-contract/result-projection.ts) |
| Team epoch, logical Worker, Membership, Task, Alert, and event types | [`src/utils/models.ts`](../../src/utils/models.ts) |
| Team authority, exact Session binding, and logical Worker persistence | [`src/utils/teams.ts`](../../src/utils/teams.ts) |
| Branch-safe hidden coordination position | [`src/utils/hidden-observation.ts`](../../src/utils/hidden-observation.ts) |
| Read-only Membership observation protocol | [`src/public/observation.ts`](../../src/public/observation.ts), exported as `@hypercarrier/pi-team-bright/observation` |
| Canonical Task card and opaque TaskVersionRef | [`src/model-tool-contract/task-domain.ts`](../../src/model-tool-contract/task-domain.ts) and [`src/model-tool-contract/task-version-ref.ts`](../../src/model-tool-contract/task-version-ref.ts) |
| Task authority, mutation semantics, and Beads translation | Task update, journal, and reconciliation-query contracts live in [`src/task-authority/contracts.ts`](../../src/task-authority/contracts.ts); [`src/task-authority/beads-reconciliation-query.ts`](../../src/task-authority/beads-reconciliation-query.ts), [`src/model-tool-contract/beads-task-adapter.ts`](../../src/model-tool-contract/beads-task-adapter.ts), [`src/model-tool-contract/beads-authority-adapter.ts`](../../src/model-tool-contract/beads-authority-adapter.ts), and [`src/utils/beads.ts`](../../src/utils/beads.ts) implement the Beads boundary; [`beads-authority-adapter.ts`](../../src/model-tool-contract/beads-authority-adapter.ts) owns the consumer-side mutation-publication port, while [`durable-task-mutation-publication.ts`](../../src/adapters/durable-task-mutation-publication.ts) implements its concrete Coordination and delivery bridge outside Task authority; [`src/utils/tasks.ts`](../../src/utils/tasks.ts) is semantic-only |
| Semantic-hardening status and dependency evidence | Maintained [`context`](../projects/semantic-hardening/context.md), [`subsystem audit`](../projects/semantic-hardening/subsystem-boundary-audit.md), and machine [`dependency map`](../projects/semantic-hardening/subsystem-dependency-map.json) |
| Event cursor, wait, filtering, and paging semantics | [`src/utils/team-events.ts`](../../src/utils/team-events.ts) |
| Human operating introduction | [Repository README](../../README.md) |
| Agent operating procedure | [`skills/pi-team-bright/SKILL.md`](../../skills/pi-team-bright/SKILL.md) |

The [contract source map](../reference.md) gives one-hop navigation without
restating executable definitions.

## Decisions still in force

- The strict Task/Beads cutover keeps native records, metadata, revisions, and
  mutation syntax inside the Beads adapter modules. `TaskCard` and opaque
  `TaskVersionRef` remain the public Task coordinates above that boundary;
  Task-owned update, journal, and reconciliation-query contracts now isolate
  recovery from the trio-facing in-memory port. The consumer-owned
  `TaskMutationPublicationPort` also isolates mutation orchestration from
  concrete Coordination, failed-hint, and delivery writers. One stateless
  durable adapter implements that port outside Task authority, and Pi composition
  injects one publishing Beads adapter factory into leader and Worker mutation
  paths. Default Beads adapters remain read-only. The old in-memory port keeps
  temporary compatibility type re-exports. `tasks.ts` is a semantic facade. Team
  authority now also owns durable lead-Session discovery; the Pi composition root
  keeps environment precedence and hook timing. Architecture impact: **changed**
  for these internal authority boundaries. HyperCarrier's canonical Structurizr DSL
  remains unchanged because it keeps Pi Team Bright internals opaque.
- Assigned Tasks are the sole durable work-delegation protocol; Alerts remain
  exceptional coordination.
- Task authority, Team/Membership authority, Pi Session identity, event
  evidence, delivery presentation, runtime observation, and terminal surfaces
  remain distinct. `pi-teams-observation/1` is recorded Membership evidence,
  never OS liveness.
- Team topology and lifecycle mutations are lead-only. Shutdown deactivates a
  Membership only after exact stop evidence. Task history and authority remain.
- `team_sync` treats `caught_up` as proven current quiescence, not permanent
  absence of future events. It reports `indeterminate` when run-state or
  actuation evidence is incomplete and does not advance observation. Pi `>=0.83`
  is the supported boundary for exact Worker `agent_start` and `agent_settled`
  evidence. Global `pi_team_bright.team` settings resolve the `120` second wait,
  enabled nudges, and the `1200` second nudge delay once per Team epoch.
- Pane placement is a typed terminal-adapter responsibility. Herdr and tmux
  receive the durable leader pane plus current Worker panes from
  [`src/utils/team-pane-placement.ts`](../../src/utils/team-pane-placement.ts),
  rather than terminal focus. They keep the leader left at at least the configured
  share, which must be greater than 0.1 and less than 1 and defaults to 0.6. They
  prove later targets still share its tab and Worker region before splitting,
  and stop only exact Worker
  panes. Pi 0.83.0 support now loads the exact working-tree extension while
  retaining normal unrelated extension and Skill discovery. A disposable Herdr
  Team with a harmless discovered extension and Skill proved two Worker Session
  bindings, Task-tool use, and exact stops. A distinct globally discovered Pi
  Team Bright copy can still conflict with explicit `-e` through duplicate tool
  registration; it remains an installation risk, not a Team storage-version
  boundary or a reason to suppress normal resources. Herdr preserves its
  established Pi launch environment allowlist.
  Other adapters retain existing behavior without this guarantee; the executable contract is
  [`TeamPanePlacement`](../../src/utils/terminal-adapter.ts).
  This changes the Pi Team Bright adapter contract, but no depicted component,
  dependency, or topology, so the Structurizr DSL is unchanged.
- Package release identity is not a Team persistence capability. New Team
  epochs do not persist a package version. Historical optional
  `implementationVersion` values remain readable as provenance and never gate
  Team operations. A future incompatible persistence change must name and test
  its actual schema or capability plus migration behavior. Fresh Team epochs
  persist an opaque epoch identity and stable logical Worker name/scope records
  separately from replaceable Membership, Session, process, and terminal
  carriers. The
  model-tool surface keeps its exact-Session branch position as locked derived
  coordination state; it never becomes Team or Task authority. Since `0.17.0-rc.3`,
  `ensure_worker.separate_window` is deliberately absent:
  durable Team configuration exclusively owns placement policy. A launch receipt
  may report exact bounded startup observation, but never Worker readiness or
  progress. Existing absent/false settings mean panes. A Team epoch captures its
  resolved `pane_layout` once: explicit `team_create.pane_layout`, trusted project
  `pi_team_bright.team.pane_layout`, global settings, then `{ leader_share: 0.6,
  worker_tiling: "linear" }`. Settings changes do not move live Teams. Herdr
  supports `linear` and deterministic `grid`; other pane backends refuse `grid`.
  Never edit a live TeamConfig or pass a Worker placement override.

## Current status and anchors

- The current source uses the real main extension as its local switch. Leader
  processes register the ten-tool model surface, with
  `ensure_worker` and exact Session binding removing low-level Team locators.
  Workers keep the narrow `task_read`, `task_update`, and `alert_send` surface;
  runtime Team binding supplies the Team identity, so Worker calls do not select
  `team_name`. Worker `alert_send` derives its only recipient, `team-lead`; its
  schema has no recipient field. Worker launch must retain normal unrelated
  extension and Skill discovery while loading its exact Pi Team Bright
  extension. Worker settings cannot re-enable leader tools. No parallel
  extension or store exists. A real ten-tool smoke exposed a release-blocking result-projection mismatch: model-tool
  semantic results entered the old generic renderer and could produce
  false human summaries. The accepted revamp now keeps raw semantic details as
  truth and derives separate validated model, collapsed TUI, expanded TUI, and
  exact QA projections. Canonical Task-card `goal` accepts one to 1,000 TypeBox
  string-length units across create input and returned Task cards. Canonical
  `current_context` uses the shared standard TypeBox schema in
  [`src/utils/beads.ts`](../../src/utils/beads.ts): one to 2,000 units. Owned
  writes keep these limits. Reads tolerate external oversized display fields
  without changing Beads: title and current context use a bounded display with
  structured `projection_warnings`, while an oversized executable goal is
  marked incomplete and remains visible with its identity, status, assignee,
  version, and Worker index coordinates, but is not executable. Structural Task
  events can advance `team_sync` without narrative evidence; journal entries
  still require committed task evidence. These public Task-card invariants change the contract, but no depicted component,
  flow, or topology, so the Structurizr DSL is unchanged. Successful TUI results
  remain concise semantic projections. Execution and result-projection errors
  instead show one copyable raw `content` and `details` report, with a warning to
  review sensitive fields before sharing. The renderer no longer hides the
  source error behind a generic missing-semantic-result message. It removes the
  old `/1` result envelope and compatibility path rather than preserving them. The internal
  diagnostic schema remains `pi-teams-status/1`. See the durable [projection
  contract](../projects/model-invoked-tool-contract.md) and [parity
  checklist](../release/model-tool-parity-checklist.md).
- Exact `0.17.0-rc.11` source commit
  `638d5934bd52c7f4a3fe18525e5d72569a227211` passed its one reserved Node
  22.22.1 aggregate: 88 files and 695 tests in 253.59 seconds. Lane closure,
  package and generated-output checks, agent and tool-result QA, public and
  persistence comparisons, 48 JSON files, 95 local links, the exact privacy
  range, and installed-tarball canaries passed. The one packed artifact contains
  93 files; its exact sizes, digests, integrity, procedure, and proof limits are
  in the [source verification
  receipt](../journal/2026-08-09-v0.17.0-rc.11-source-verification-receipt.md).
  The source carries internal Task and Team dependency hardening with no public
  behavior change. It remains untagged and unpublished: no push, npm publication,
  npm `next` change, provenance claim, or GitHub release occurred. The dated
  [release plan](../journal/2026-08-09-v0.17.0-rc.11-release-plan.md) keeps
  publication operations separate.
- `0.17.0-rc.10` remains published from exact tagged source `1214303`; npm `next`
  points to it. It removes package version as a Team compatibility gate and
  removes the obsolete fixture constant. The durable [rc.10 release
  receipt](../journal/2026-08-08-v0.17.0-rc.10-release-receipt.md) records exact
  CI, historical-config integration E2E, package, registry, and provenance
  evidence. The [rc.9 release
  receipt](../journal/2026-08-07-v0.17.0-rc.9-release-receipt.md), [aborted rc.6
  receipt](../journal/2026-08-05-v0.17.0-rc.6-release-receipt.md), [published
  rc.7 receipt](../journal/2026-08-05-v0.17.0-rc.7-release-receipt.md), and
  [published rc.8
  receipt](../journal/2026-08-05-v0.17.0-rc.8-release-receipt.md) remain
  historical evidence. The current release accepts `0.1 < leader_share < 1.0`
  while keeping the default at `0.6`. The README shows one complete Team and
  Worker settings example and makes tool precedence explicit: `enable` adds to
  the inherited Worker list, then `disable` removes from it.
- `@beads/bd@1.1.0` is an owned runtime dependency. The Beads adapter resolves
  its package-local CLI, so Pi's parent PATH need not contain `node_modules/.bin`
  or a separately installed `bd`; normal npm/Git installation acquires the
  matching native binary for supported x64 and arm64 Node platforms. Missing or
  unsupported owned binaries report typed unavailable `bd` errors. CI verifies
  and materializes the pinned official linux-amd64 binary because upstream
  postinstall deliberately skips binary download when `CI` is set. One
  source-controlled materializer verifies and installs the official linux-amd64
  archive for both CI and the manual publish workflow; publishing defaults to a
  non-mutating dry run.
- `npm test` type-checks and runs the fast deterministic lane, not the full
  contract/lifecycle/integration suite. CI on Node 22/24 runs it plus
  `test:exhaustive-only` and package verification; publish on Node 24 runs
  `test:full` and package verification. `npm run verify:package` installs the packed artifact in
  a clean temporary project and probes the scoped observation import in CommonJS
  and TypeScript.
- `team_sync({view:"updates"})` now has normal liveness outcomes. It returns
  `caught_up` when the exact leader is caught up and no current Worker producer
  requires a wait. It returns `indeterminate` when required Worker run-state or
  actuation evidence is incomplete; this does not advance the hidden
  observation. Pi `>=0.83` is required for exact `agent_start` and
  `agent_settled` evidence. Global `pi_team_bright.team.wait_seconds` controls
  the bounded wait and keeps its `120` second default. The same global section
  resolves internal sync nudges: `nudge_enabled` defaults to `true`, and
  `nudge_delay_seconds` defaults to `1200`. A nudge is one exact-leader
  presentation record, not an Alert, Task mutation, or observation advance.
- Task mutation publication now crosses a consumer-owned port. The durable
  adapter preserves Beads commit, Membership-lease release, acting-Session
  suppression, serial event, failed-hint, recipient delivery, inline recovery,
  and owner-transition completion order. Exact warnings and partial-failure
  continuation remain unchanged. The verified tree has 68 production files and
  231 static local edges, with no nontrivial SCC or dynamic import. Independent
  evidence passed 113 focused tests plus type, QA, lane, package, public-surface,
  persistence, and diff checks. The canonical non-self-referential 16-path
  source/test digest is `d6da537790c95ac42ef741c5aa2f1fdf6999966ac76c525190838b01d8f96219`.
  Task event publication records payload-light failed-event hints. Updates use
  event and Task-authority revisions, and a failed event append cannot advance
  the hidden watermark or hide an authoritative Task change. Required Task
  references use bounded sequential Beads hydration batches of at most 16 IDs;
  incomplete hydration returns typed `task_authority_unavailable` and publishes
  no observation. See the [rc.9 coordination research handoff](../journal/2026-08-07-coordination-correctness-research-handoff.md)
  and [implementation continuation](../journal/2026-08-07-coordination-correctness-implementation-continuation.md).
- The release source validates the Pi 0.84 footer subscription-auth boundary
  through the shared context registry. A resumed leader binds its exact Session
  before nudge-debt reads; the focused proof covers one presentation, fork and
  stale-binding suppression, and the durable/model/TUI projection boundary.
- Worker resource settings are a Worker-process projection only. The executable
  parser plus Worker tool and CLI aggregate projection are
  [`src/utils/worker-resource-projection.ts`](../../src/utils/worker-resource-projection.ts),
  wired at Worker session and launch composition in
  [`extensions/index.ts`](../../extensions/index.ts). It reads the active Pi global
  directory and trusted project settings under `pi_team_bright.worker`. The launch
  resolves one Pi trust boolean for both trusted project settings and child
  `--approve`/`--no-approve`: a saved decision for a different Worker cwd wins,
  otherwise the Worker inherits the leader's resolved trust, with `true` when the
  trust context is unavailable. An available `default_model`, split at its first
  slash into provider and nonempty model ID, is captured on new Membership only
  after explicit Worker/template and durable Team defaults; invalid settings refuse
  before carrier creation, while recovery uses the captured Membership model. It
  never changes native Pi settings, Task, Session, or observation records. This is
  a Worker launch contract change with no topology change. Intent and reversal criteria are in
  [decision 0008](../decisions/0008-worker-resource-projection.md).
- One current Membership admits one live Pi process generation. The executable
  rule is [`src/utils/runtime.ts`](../../src/utils/runtime.ts), lifecycle wiring
  is [`extensions/index.ts`](../../extensions/index.ts), and focused evidence is
  in [`src/utils/runtime-startup-admission.test.ts`](../../src/utils/runtime-startup-admission.test.ts)
  and [`src/utils/session-lifecycle.test.ts`](../../src/utils/session-lifecycle.test.ts).
  Intent is in [decision 0007](../decisions/0007-one-live-process-binding.md);
  the independent receipt is
  [`2026-07-30-one-live-process-binding.json`](../journal/artifacts/2026-07-30-one-live-process-binding.json).

## Active Projects

Three audit-driven Projects are active. Each routes through maintained Project
artifacts; dated evidence remains in the journal. They do not replace this repository-level
context or the executable contract sources.

- [Semantic hardening](../projects/semantic-hardening/context.md) is in
  consolidation and hardening. Exact rc.11 source `638d5934` passed the reserved
  aggregate and local release gates but remains untagged and unpublished. Task
  reconciliation and Task mutation publication use explicit dependency seams.
  `TASK-PUBLICATION-INVERSION` is implemented and independently verified.
  ALERT-004 remains unclassified, and Team, Alert, Coordination, Trio, and
  additive Membership-observation boundary work remains
  incomplete. The maintained [subsystem audit](../projects/semantic-hardening/subsystem-boundary-audit.md)
  and machine [dependency map](../projects/semantic-hardening/subsystem-dependency-map.json)
  own current structural evidence.
- [Model-invoked tool contract](../projects/model-invoked-tool-contract.md) is in
  hardening under the one-leader/multiple-Worker topology. The owner accepted
  `team_create`, `ensure_worker`, and `team_sync` as the initial end-to-end
  journey. The raw semantic result remains machine truth. The accepted projection
  boundary sends the model only decision-relevant validated JSON, renders
  concise allowlisted TUI views, and keeps exact raw/model comparisons in QA.
  Singleton Task results do not expose batch nesting. The retired result
  envelope, pass-through model projection, and generic legacy renderer are
  removed from the current surface. The model-tool surface has no
  model-managed Team locator, cursor, count cap, or paging. The durable
  model-tool surface composes Team epochs, logical Worker meaning, exact
  lead-Session binding, Beads model-tool metadata, structured events, hidden
  branch position, authoritative Task rescan, and the existing Worker launch
  bridge through the real main extension. The Beads adapter modules are the only
  translation boundary for authority records; Team events, sync actions, and
  Task reads above them use canonical Task cards. The semantic Task facade now
  delegates mutation authority below that adapter, and Worker claim execution
  uses the adapter's canonical claim path. Delivery accepts opaque
  TaskVersionRef coordinates and refuses raw revisions; stopped epochs use the
  bounded adapter-backed delivery-record migration in
  [`src/utils/task-delivery-migration.ts`](../../src/utils/task-delivery-migration.ts). Run the explicit stopped-epoch operation with `npm run migrate:task-delivery -- <team-name>`; it refuses any active Membership and never runs during normal delivery.
  Normal runtime records are canonical-only and refuse with `upgrade_required`
  until a stopped epoch completes migration. Recovery reconciliation hydrates
  listed IDs through one adapter multi-ID read and refuses metadata gaps; it
  never inserts placeholder Task meaning. Delivery publication also refuses
  when the adapter cannot provide canonical current context or goal evidence. The adapter owns expected-version
  checks and operation replay, while publication reuses its canonical post-state
  card and adds no authority read. Stale and conflicting operations refuse
  without a second model-tool mutation. The redacted receipt is [`2026-08-02-durable-preview-local-canary.json`](../journal/artifacts/2026-08-02-durable-preview-local-canary.json).
  The public rc.3 release now proves package delivery and provenance; the
  Worker mutation surface remains the bounded three-tool projection. The
  strict Task boundary is now enforced by the adapter-owned claim path,
  canonical delivery coordinates, and the semantic facade split; do not treat
  raw authority records as Task contracts.
- [Task-engine performance](../projects/task-engine-performance.md) is in
  hardening measurement. It owns trace repair, benchmark design, current
  performance assessment, and optimization selection.

## Constraints and open work

The completed rc.3 ten-Worker stress run closed all 160 Tasks, applied the full
159-edge dependency chain, stopped all Workers, and shut down with no unfinished
Task IDs. It also confirmed the Beads/Dolt contention tail and the unavailable
bulk snapshot path at this scale. The maintained snapshot path now selects
Team-scoped candidate IDs with `bd list` and hydrates candidate metadata with
one native multi-ID `bd show`; it must not regress to N+1 external CLI calls. The
[source and benchmark investigation](../journal/2026-08-04-beads-read-path-investigation.md)
shows that native `show` still loops per ID, while bulk export is faster but not
semantically equivalent. Three full 18-Task snapshots then measured a
5.197-second median against the rc.4 baseline mean of 14.040 seconds: a 63.0%
latency reduction and 2.70x speedup. Exact create replay can still return a false operation
conflict after its Task evolves, and a replayed authority commit can remain without its Task-creation
event or delivery. The final assessment is
[`2026-08-03-rc3-stress-final-assessment.md`](../journal/2026-08-03-rc3-stress-final-assessment.md).
The nontrivial repair design remains in
[`2026-08-03-stress-team-rc3-investigation-handoff.md`](../journal/2026-08-03-stress-team-rc3-investigation-handoff.md).
The required observation invariant remains one complete coordination observation
or no semantic observation. An unavailable Task authority must not advance the
internal watermark, report zero Tasks, or present the last complete projection
as fresh. The run does not establish a supported 160-Task snapshot capacity.

Next steps:

1. Design immutable Task-create operation identity before changing replay code.
2. Measure and repair Beads contention before making a Worker-capacity claim.
3. Keep malformed-event diagnostics distinct from normal structural Task
   events; structural creation, assignment, status, and relation events now
   sync without narrative evidence.
4. Add payload-free outer-operation trace correlation before the representative
   performance epoch.
5. Benchmark snapshot and update views at 1, 20, and 60 Tasks, both idle and
   under concurrent writes. These workload points are not public count limits.
6. Define observation and cleanup for a reserved recovery carrier that never
   publishes runtime evidence. Keep it pending; do not infer readiness or work.


## Test lanes

`npm test` is fast and non-exhaustive; `test:exhaustive-only` is its CI complement, `test:full` runs everything, and `test:lanes` verifies closure. Use `test:external` for real Beads/Dolt diagnostics, `qa:agent-surface` for the agent-surface artifact, and `qa:tool-results` for receipt QA. CI on Node 22/24 runs fast plus the complement and package verification; publishing on Node 24 runs full plus package verification.
