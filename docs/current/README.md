# Pi Team Bright evergreen context

Updated: 2026-08-04

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
| Task authority and mutation semantics | [`src/utils/tasks.ts`](../../src/utils/tasks.ts) and [`src/utils/beads.ts`](../../src/utils/beads.ts) |
| Event cursor, wait, filtering, and paging semantics | [`src/utils/team-events.ts`](../../src/utils/team-events.ts) |
| Human operating introduction | [Repository README](../../README.md) |
| Agent operating procedure | [`skills/pi-team-bright/SKILL.md`](../../skills/pi-team-bright/SKILL.md) |

The [contract source map](../reference.md) gives one-hop navigation without
restating executable definitions.

## Decisions still in force

- Assigned Tasks are the sole durable work-delegation protocol; Alerts remain
  exceptional coordination.
- Task authority, Team/Membership authority, Pi Session identity, event
  evidence, delivery presentation, runtime observation, and terminal surfaces
  remain distinct. `pi-teams-observation/1` is recorded Membership evidence,
  never OS liveness.
- Team topology and lifecycle mutations are lead-only. Shutdown deactivates a
  Membership only after exact stop evidence. Task history and authority remain.
- Pane placement is a typed terminal-adapter responsibility. Herdr and tmux
  receive the durable leader pane plus current Worker panes from
  [`src/utils/team-pane-placement.ts`](../../src/utils/team-pane-placement.ts),
  rather than terminal focus. They keep the leader left at at least 60% width,
  prove later targets still share its tab and Worker region before splitting,
  and stop only exact Worker
  panes. Pi 0.83.0 support now loads the exact working-tree extension while
  retaining normal unrelated extension and Skill discovery. A disposable Herdr
  Team with a harmless discovered extension and Skill proved two Worker Session
  bindings, Task-tool use, and exact stops. A distinct globally discovered Pi
  Team Bright copy still conflicts with explicit `-e`; it remains a documented
  single-version-epoch installation risk, not a reason to suppress normal
  resources. Herdr preserves its established Pi and proxy environment allowlist.
  Other adapters retain existing behavior without this guarantee; the executable contract is
  [`TeamPanePlacement`](../../src/utils/terminal-adapter.ts).
  This changes the Pi Team Bright adapter contract, but no depicted component,
  dependency, or topology, so the Structurizr DSL is unchanged.
- One live Team runs one Pi Team Bright version; upgrades happen as a stopped
  and restarted epoch, not a rolling deployment. Fresh Team epochs persist an
  opaque epoch identity and stable logical Worker name/scope records separately
  from replaceable Membership, Session, process, and terminal carriers. The
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

- The `0.17.0-rc.4` release candidate uses the real main extension as its local
  switch. Leader processes register the ten-tool model surface, with
  `ensure_worker` and exact Session binding removing low-level Team locators.
  Workers keep `task_read`, `task_update`, and `alert_send` over the same Team
  and Beads authorities. Worker `alert_send` derives its only recipient,
  `team-lead`; its schema has no recipient field. Worker launch must retain
  normal unrelated extension and Skill discovery while loading its exact Pi Team
  Bright extension. Worker settings cannot re-enable leader tools. No parallel
  extension or store exists. A real ten-tool smoke exposed a release-blocking result-projection mismatch: model-tool
  semantic results entered the old generic renderer and could produce
  false human summaries. The accepted revamp now keeps raw semantic details as
  truth and derives separate validated model, collapsed TUI, expanded TUI, and
  exact QA projections. Candidate Task-card `goal` accepts one to 1,000 TypeBox
  string-length units across create input and returned Task cards. Candidate
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
- `@hypercarrier/pi-team-bright@0.17.0-rc.4` is the prepared release candidate.
  It adds strict stress-recovery guidance and the `pi-team-bright` packaged
  Skill name without changing Task authority behavior. The published rc.3
  registry and provenance evidence remains in the
  [`v0.17.0-rc.3` release receipt](../journal/2026-08-03-v0.17.0-rc.3-release-receipt.md).
  Record rc.4 publication only after registry and provenance verification.
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

Two audit-driven Projects are active. Each has one maintained Project artifact;
dated evidence remains in the journal. They do not replace this repository-level
context or the executable contract sources.

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
  bridge through the real main extension. Leader Task updates use
  expected-version preflight plus durable operation metadata replay; stale and
  conflicting operations refuse without a second model-tool mutation. The
  redacted receipt is [`2026-08-02-durable-preview-local-canary.json`](../journal/artifacts/2026-08-02-durable-preview-local-canary.json).
  The public rc.3 release now proves package delivery and provenance; the
  Worker mutation surface remains the bounded three-tool projection.
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
6. Restart live Teams as one version epoch after an upgrade or rollback.
7. Define observation and cleanup for a reserved recovery carrier that never
   publishes runtime evidence. Keep it pending; do not infer readiness or work.


## Test lanes

`npm test` is fast and non-exhaustive; `test:exhaustive-only` is its CI complement, `test:full` runs everything, and `test:lanes` verifies closure. Use `test:external` for real Beads/Dolt diagnostics, `qa:agent-surface` for the agent-surface artifact, and `qa:tool-results` for receipt QA. CI on Node 22/24 runs fast plus the complement and package verification; publishing on Node 24 runs full plus package verification.
