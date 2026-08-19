# Pi Team Bright evergreen context

Updated: 2026-08-19

Current published release: stable `0.17.2` is on npm `latest` from annotated
tag `v0.17.2` and the GitHub Release at
`https://github.com/deephbz/pi-team-bright/releases/tag/v0.17.2`. npm `next`
remains on historical prerelease `0.17.0-rc.14`.

Patch `0.17.2` uses Herdr's official interactive-ready command with an explicit
6,000 ms readiness timeout. Patch candidate `0.17.3` names the exact pane handle
returned by split before Agent startup. Label failure is warned and traced but
cannot block Worker coordination. The candidate is backward compatible with
`0.17.2` Team state and changes no Team storage, Task graph, model-tool,
Membership, or Worker protocol contract. It is not pushed, tagged, published,
or a GitHub Release.

Lifecycle stage: **hardening** for the DAG-native Task coordination release.
The published Task-first surface is unchanged. The Membership-observation surface remains in **sharing**.

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
| Public tool selection and TUI message projection | [`src/model-tool-contract/result-projection.ts`](../../src/model-tool-contract/result-projection.ts), [`src/model-tool-contract/tui-projection.ts`](../../src/model-tool-contract/tui-projection.ts), [`src/model-tool-contract/tui-message-projection.ts`](../../src/model-tool-contract/tui-message-projection.ts), and [`extensions/index.ts`](../../extensions/index.ts). The executable review inventory is [`tui-message-gallery.ts`](../../src/model-tool-contract/tui-message-gallery.ts). |
| Worker-only settings resource projection | [`src/utils/worker-resource-projection.ts`](../../src/utils/worker-resource-projection.ts) and its focused tests |
| Tool parameters, descriptions, guards, and execution | TypeBox registrations in [`extensions/index.ts`](../../extensions/index.ts) |
| Machine result schema | Raw catalog unions and model projection schemas in [`src/model-tool-contract/result-projection.ts`](../../src/model-tool-contract/result-projection.ts) |
| Team epoch, logical Worker, Membership, Task, Alert, and event types | [`src/utils/models.ts`](../../src/utils/models.ts) |
| Team authority, exact Session binding, and logical Worker persistence | [`src/utils/teams.ts`](../../src/utils/teams.ts) |
| Branch-safe hidden coordination position | [`src/utils/hidden-observation.ts`](../../src/utils/hidden-observation.ts) |
| Read-only Membership observation protocol | [`src/public/observation.ts`](../../src/public/observation.ts), exported as `@hypercarrier/pi-team-bright/observation`; [`src/team-authority/membership-observation-reader.ts`](../../src/team-authority/membership-observation-reader.ts) is its private read-only decoder |
| Canonical Task card and opaque TaskVersionRef | [`src/task-authority/task-domain.ts`](../../src/task-authority/task-domain.ts) and [`src/task-authority/task-version-ref.ts`](../../src/task-authority/task-version-ref.ts) |
| Task authority, reads, mutation semantics, and legacy Beads translation | [`src/task-authority/graph-control.ts`](../../src/task-authority/graph-control.ts) owns graph revisions, Attempts, derived state, bounded failure traversal, replay, and recovery. [`durable-graph-task-authority.ts`](../../src/adapters/durable-graph-task-authority.ts) owns the Team snapshot, and [`graph-orchestration.ts`](../../src/task-authority/graph-orchestration.ts) owns publication and ready delivery. [`src/task-authority/contracts.ts`](../../src/task-authority/contracts.ts), the durable read adapters, and the Beads adapters remain the legacy pre-graph path. [`durable-task-mutation-publication.ts`](../../src/adapters/durable-task-mutation-publication.ts) is the shared Coordination and delivery bridge. |
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
- Displayed extension messages use one audience projection and one bold
  `[pi-team-bright.<message-type>]` first line. Collapsed mode is concise, and
  detail mode adds raw structured JSON. Tool calls own the header while results
  own the body. New Task and direct-message entries use `pi-team-bright.*`;
  historical `pi-teams.*` entries remain read-compatible only. The exhaustive,
  non-mutating terminal gallery is the human review surface. This is
  [decision 0011](../decisions/0011-unified-tui-message-projection.md).
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
  established Pi launch environment allowlist. After `pane split`, the adapter
  uses the exact returned pane handle with official `pane rename` before
  `agent start`. A label failure records a payload-free launch stage and warning
  but does not block coordination. The extra local CLI call measured 24.72 ms
  and does not change the separate 6,000 ms readiness bound.
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

- The selected stable source now contains the graph-native production path.
  `task_graph_apply` replaces `task_create` without adding a
  leader tool. A Team-scoped snapshot stores complete graph revisions,
  immutable Attempts, replay receipts, and per-Attempt model resolution.
  `dependency_waiting` and `ready` are derived; only `goal_achieved` releases a
  prerequisite, while `goal_failed` applies a bounded failure edge. Runtime
  composition includes recovery, ready delivery, Coordination reads, lifecycle
  guards, and Worker transitions. Before the first graph apply, Beads remains
  the legacy Task authority and read fallback; graph-native Worker transitions
  bridge claim, block, resume, explicit goal success, and context through its
  versioned adapter. Goal failure and cancellation refuse there, rather than
  overload legacy `closed` or `blocked` state. Beads is not a graph-state mirror.
  The durable integration result and exact remaining gaps are in
  [`2026-08-13-graph-control-integration-result.md`](../journal/2026-08-13-graph-control-integration-result.md).
  This changes internal Task authority, persistence, dispatch, and model
  contracts. HyperCarrier's diagram stays unchanged because it keeps Pi Team
  Bright opaque.
- The current source uses the real main extension as its local switch. Leader
  processes register the nine-tool DAG-native model surface, with
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
  stay concise when collapsed and add one copyable raw `content` and `details`
  report in detail mode, with a warning to review sensitive fields before
  sharing. The renderer no longer hides the source error behind a generic missing-semantic-result message. It removes the
  old `/1` result envelope and compatibility path rather than preserving them. The internal
  diagnostic schema remains `pi-teams-status/1`. See the durable [projection
  contract](../projects/model-invoked-tool-contract.md) and [parity
  checklist](../release/model-tool-parity-checklist.md).
- `0.17.0-rc.14` is the published liveness and Worker-recovery base at exact
  release code `8bb517bd32d8687e97b96a531db15833fd64420a`. Selected stable
  `0.17.0` source adds atomic graph creation,
  mechanical ready-front dispatch, graph control, the read-only Task graph
  pane, and Worker-startup hardening. Its earlier eight-Worker stress closed
  117/117 Tasks and stopped all Workers. The maintained
  [DAG-native context](../projects/dag-native/context.md) owns graph evidence.
  The pane has a fixed full-component sentinel, orthogonal routes, a concise
  HUD, pan and selection modes, spatial navigation, bounded Task details, and
  explicit unknown-history timing. It pins its TypeScript project when Herdr
  launches from another cwd. Status colors use terminal-owned semantic ANSI
  slots, so Colorstack and other terminal themes control light and dark color.
  The configurable [DAG gallery](../../src/task-graph-view/gallery/default.json)
  covers all seven graph states across disconnected islands without changing
  Task authority. TB routes now use an outside right repair lane, while LR
  routes use an outside lower repair lane. Arrows remain outside intact node
  borders, and the legend plus retry badge carry edge meaning without inline
  labels overwriting topology. Exact executable source `3ee1d4c5` passed the one
  allowed 1,004-test aggregate, all release-specific gates, a 197-file package
  dry run, candidate-range privacy, and a proxy-backed real Team canary. The
  canary mechanically advanced `A -> B`, recorded Worker-authored accepted
  Attempts, reused the same stable Worker, and shut down cleanly. The rebased
  routing follow-up passed exact graph-path comparison, typecheck, 35 focused
  tests, both sentinels, gallery/export, and package verification. Stable source
  then passed 142 aggregate files and 1,007 tests, package and lane gates, and a
  fresh all-tool Team E2E. Main CI, immutable package integrity, registry,
  provenance, tag, and GitHub Release evidence are complete in the stable
  `v0.17.0` release receipt.
- Patch `0.17.1` resolves the graph-pane origin from the exact live
  Herdr pane rather than inherited tab and workspace coordinates. It keeps the
  resolved live location for split and close fencing. Missing, non-exact, or
  moved child panes still refuse. This is an internal terminal-adapter fix with
  architecture impact: **none**. The accepted evidence is
  [`graph-pane-origin-fix.md`](../journal/artifacts/2026-08-15-pi0842/graph-pane-origin-fix.md).
- Patch `0.17.1` also repairs a stale-lock recovery TOCTOU: after a losing
  exclusive claim create, a missing fixed claim is ordinary contention and
  retries. A present stale malformed claim still fails closed. This changes an
  internal lock guard only; architecture impact: **none**.
- Worker startup hardening removes two avoidable serial costs without weakening
  admission. Herdr uses one official interactive-ready start command with an
  explicit 6,000 ms readiness timeout. Exact current Membership, Session, and
  runtime-generation binding remains the commit point and keeps its separate
  ordinary 3,000 ms observation. Configured Worker defaults use the
  invocation-local model registry. `ensure_worker` no longer runs a leader Task
  scan; Session start, Task transitions, and periodic recovery own ready
  delivery. Real stable-Worker reuse measured 31/33 ms p50/p95, while normal
  fresh Pi RPC bootstrap measured 448/461 ms. Keep stable Workers bound. Do not
  add a generic warm pool or Node compile cache. The maintained [performance
  project](../projects/worker-startup-performance.md), superseding [official
  Herdr decision](../decisions/0013-official-herdr-ready-start.md), and [final
  2026-08-14 assessment](../journal/2026-08-14-worker-startup-final-assessment.md)
  own the evidence and limits.
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
- Worker admission remains a two-phase external-actuation protocol. Herdr
  acceptance is positive actuation evidence, not Worker authority. Exact
  Membership, Session, and runtime-generation binding is the linearization
  point. A timeout is suspicion, not proof of death; exact-target compensation
  and generation fencing handle late or lost outcomes. Installed Herdr 0.7.5
  lacks the accepted flag, so its exact parser rejection selects the safe legacy
  ready wait. Do not reinterpret the fallback, timeout, pane, or process as
  readiness.
- One current Membership admits one live Pi process generation. The executable
  rule is [`src/utils/runtime.ts`](../../src/utils/runtime.ts), lifecycle wiring
  is [`extensions/index.ts`](../../extensions/index.ts), and focused evidence is
  in [`src/utils/runtime-startup-admission.test.ts`](../../src/utils/runtime-startup-admission.test.ts)
  and [`src/utils/session-lifecycle.test.ts`](../../src/utils/session-lifecycle.test.ts).
  Intent is in [decision 0007](../decisions/0007-one-live-process-binding.md);
  the independent receipt is
  [`2026-07-30-one-live-process-binding.json`](../journal/artifacts/2026-07-30-one-live-process-binding.json).

## Active Projects

Four audit-driven Projects are active. Each routes through maintained Project
artifacts; dated evidence remains in the journal. They do not replace this repository-level
context or the executable contract sources.

- [Semantic hardening](../projects/semantic-hardening/context.md) is in
  consolidation and hardening. Accepted uncommitted Task read and
  `TaskChangeDelivery` ports keep native reads and exact-recipient delivery
  leases behind explicit external adapters. `BeadsTaskAdapter` has no default
  authority constructor. The delivery port is mandatory and covers send and
  acknowledgement leases, ordering, replacement refusal, and replay parity.
  Independent acceptance and re-verification passed focused checks, typecheck,
  public/persistence diffs, and source fences; no aggregate ran. Stopped
  migration remains separate. Pi Session Team-query and Coordination hidden-
  observation ports are accepted. Task/Team reverse dependencies and
  Coordination runtime, event, and nudge-actuation seams remain open. The maintained [subsystem audit](../projects/semantic-hardening/subsystem-boundary-audit.md)
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
- [Worker startup performance](../projects/worker-startup-performance.md) has a
  hardening result. Stable bound-Worker reuse is the supported sub-100 ms path.
  Fresh Pi remains about 450 ms before exact Worker binding. Accepted actuation,
  in-process model validation, and removal of leader Task reconciliation are
  selected. Generic pooling, resource exclusions, bundling, and compile caching
  remain rejected.

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

1. Keep stable `v0.17.1` and its package bytes immutable. Record downstream
   HyperCarrier gitlink adoption as separate composition evidence.
2. Preserve stable `v0.17.0` and all earlier release artifacts.
3. Define carrier actuation for Attempt model aliases before claiming that
   `capable` changes an existing Worker's active model.
4. Decide whether graph persistence needs an append-only transaction store and
   exact Coordination publication outbox.
5. Design immutable legacy Task-create operation identity before changing Beads
   replay code.
6. Measure and repair Beads contention before making a Worker-capacity claim.
7. Keep malformed-event diagnostics distinct from normal structural Task
   events; structural creation, assignment, status, and relation events now
   sync without narrative evidence.
8. Add payload-free outer-operation trace correlation before the representative
   performance epoch.
9. Benchmark snapshot and update views at 1, 20, and 60 Tasks, both idle and
   under concurrent writes. These workload points are not public count limits.
10. Keep stable Workers bound when low-latency repeated work matters. The
    separate [`worker-ensure-concurrency.md`](../projects/worker-ensure-concurrency.md)
    context defers batched sibling-launch optimization for later design. Add
    public Pi phase tracing before another cold-start optimization.
11. Do not add generic warm capacity, a reusable Pi Session, a Node compile
    cache, a Bun bundle, or Worker resource exclusions. A future strict 100 ms
    new-Worker SLO needs a separately shaped one-use sealed launcher with a
    profile digest, CAS reservation, activation identity, exact fences,
    destroy-on-outcome behavior, lost-actuation reconciliation, and measured
    stockout and replenishment distributions.


## Test lanes

`npm test` is fast and non-exhaustive; `test:exhaustive-only` is its CI complement, `test:full` runs everything, and `test:lanes` verifies closure. Use `test:external` for real Beads/Dolt diagnostics, `qa:agent-surface` for the agent-surface artifact, and `qa:tool-results` for receipt QA. CI on Node 22/24 runs fast plus the complement and package verification; publishing on Node 24 runs full plus package verification.
