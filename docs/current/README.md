# Pi Team Bright evergreen context

Updated: 2026-08-02

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
| Public tool selection and TUI renderer attachment | [`PI_TEAMS_PUBLIC_TOOLS`](../../src/utils/tool-result-renderer.ts) and [`extensions/index.ts`](../../extensions/index.ts) |
| Worker-only settings resource projection | [`src/utils/worker-resource-projection.ts`](../../src/utils/worker-resource-projection.ts) and its focused tests |
| Tool parameters, descriptions, guards, and execution | TypeBox registrations in [`extensions/index.ts`](../../extensions/index.ts) |
| Machine result schema | [`PiTeamsToolResultDetails`](../../src/utils/tool-results.ts) |
| Team epoch, logical Worker, Membership, Task, Alert, and event types | [`src/utils/models.ts`](../../src/utils/models.ts) |
| Team authority, exact Session binding, and logical Worker persistence | [`src/utils/teams.ts`](../../src/utils/teams.ts) |
| Branch-safe hidden coordination position | [`src/utils/hidden-observation.ts`](../../src/utils/hidden-observation.ts) |
| Read-only Membership observation protocol | [`src/public/observation.ts`](../../src/public/observation.ts), exported as `@hypercarrier/pi-team-bright/observation` |
| Task authority and mutation semantics | [`src/utils/tasks.ts`](../../src/utils/tasks.ts) and [`src/utils/beads.ts`](../../src/utils/beads.ts) |
| Event cursor, wait, filtering, and paging semantics | [`src/utils/team-events.ts`](../../src/utils/team-events.ts) |
| Human operating introduction | [Repository README](../../README.md) |
| Agent operating procedure | [`skills/pi-teams/SKILL.md`](../../skills/pi-teams/SKILL.md) |

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
- One live Team runs one Pi Team Bright version; upgrades happen as a stopped
  and restarted epoch, not a rolling deployment. Fresh Team epochs persist an
  opaque epoch identity and stable logical Worker name/scope records separately
  from replaceable Membership, Session, process, and terminal carriers. The
  model-tool preview keeps its exact-Session branch position as locked derived
  coordination state; it never becomes Team or Task authority. Since `0.16.0-rc.1`,
  `worker_ensure.separate_window` is deliberately absent:
  durable Team configuration exclusively owns placement policy. A launch receipt
  may report exact bounded startup observation, but never Worker readiness or
  progress. Existing absent/false settings mean panes; stop the Team and create
  a new epoch with `team_create.separate_windows=true` to adopt windows—never
  edit config or pass a Worker override, and unsupported carriers refuse.

## Current status and anchors

- The `0.16.0-rc.2` public surface has ten tools, one versioned result envelope,
  and a read-only `/pi-team-bright [status|help]` command. The
  `0.17.0-rc.1` release candidate uses the real main extension as its local
  switch: leader processes register the ten-tool model surface, with
  `worker_ensure` renamed to `ensure_worker` and exact Session binding removing
  low-level Team locators. Preview Workers keep the current
  `task_read`, `task_update`, and `alert_send` surface over the same Team and
  Beads authorities. No parallel preview extension or store exists. The
  internal diagnostic schema remains `pi-teams-status/1`. See the durable
  [parity checklist](../release/model-tool-parity-checklist.md).
- `@hypercarrier/pi-team-bright@0.17.0-rc.1` is the prepared public release
  candidate. It adds the complete exact-Session ten-tool model surface while
  preserving one-live-process startup admission and the Task-first authority.
  Compatibility metadata covers the tested Pi 0.80.10 and 0.82.x minor lines.
  Publication uses the manually dispatched GitHub Actions OIDC workflow and
  the npm `next` dist-tag.
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
  [`extensions/index.ts`](../../extensions/index.ts). It reads only Pi global
  settings and trusted project settings under `pi_team_bright.worker`; it never
  changes Team, Membership, Task, Session, or observation records. Intent and
  reversal criteria are in [decision 0008](../decisions/0008-worker-resource-projection.md).
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
  shaping under the one-leader/multiple-Worker topology. The owner accepted
  `team_create`, `ensure_worker`, and `team_sync` as the initial end-to-end
  journey. Results default to minified named JSON; the projection seam is
  identity-only, and
  alternative encodings are outside the initial end-to-end delivery. The
  candidate has no model-managed Team locator, cursor, count cap, or paging.
  The branch-local durable release candidate composes Team epochs, logical
  Worker meaning, exact lead-Session binding, Beads candidate metadata,
  structured events, hidden branch position, authoritative Task rescan, and
  the existing Worker launch bridge through the real main extension. Leader
  Task updates now use expected-version preflight plus durable operation
  metadata replay; stale and conflicting operations refuse without a second
  candidate mutation. The redacted receipt is
  [`2026-08-02-durable-preview-local-canary.json`](../journal/artifacts/2026-08-02-durable-preview-local-canary.json).
  This proves the first local decision loop, not public cutover or a durable
  candidate Worker mutation surface.
- [Task-engine performance](../projects/task-engine-performance.md) is in
  hardening measurement. It owns trace repair, benchmark design, current
  performance assessment, and optimization selection.

## Constraints and open work

One live blocker remains below the recovered Worker lifecycle: ordinary
`team_sync` intermittently times out in the single underlying Beads `list`
command while live Workers settle Tasks. The shaping target is one complete
coordination observation or no semantic observation. An unavailable Task
authority must not advance the internal watermark, report zero Tasks, or
present the last complete projection as fresh. This availability policy must
settle before the performance Project optimizes its implementation.

Next steps:

1. Run the focused release checks, then let the independent release verifier
   run the complete release lane against the exact working tree.
2. Add payload-free outer-operation trace correlation before starting the new
   representative `PI_TEAMS_TRACE_JSONL` Team epoch.
3. Benchmark snapshot and update views at 1, 20, and 60 Tasks, both idle and
   under concurrent writes. These workload points are not public count limits.
4. Restart live Teams as one version epoch after an upgrade or rollback.
5. Define observation and cleanup for a reserved recovery carrier that never
   publishes runtime evidence. Keep it pending; do not infer readiness or work.
6. Reassess component stage at the next R&D kickoff. New experimental pieces
   may return to exploration without weakening anchors for the hardened core.


## Test lanes

`npm test` is fast and non-exhaustive; `test:exhaustive-only` is its CI complement, `test:full` runs everything, and `test:lanes` verifies closure. Use `test:external` for real Beads/Dolt diagnostics, `qa:agent-surface` for the agent-surface artifact, and `qa:tool-results` for receipt QA. CI on Node 22/24 runs fast plus the complement and package verification; publishing on Node 24 runs full plus package verification.
