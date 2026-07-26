# Pi Team Bright evergreen context

Updated: 2026-07-26

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
| Tool parameters, descriptions, guards, and execution | TypeBox registrations in [`extensions/index.ts`](../../extensions/index.ts) |
| Machine result schema | [`PiTeamsToolResultDetails`](../../src/utils/tool-results.ts) |
| Team, Membership, Task, Alert, and event types | [`src/utils/models.ts`](../../src/utils/models.ts) |
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
  and restarted epoch, not a rolling deployment. In unpublished pre-1.0
  `0.16.0-rc.1`, `worker_ensure.separate_window` was deliberately removed:
  durable Team configuration exclusively owns placement policy. A launch receipt
  may report exact bounded startup observation, but never Worker readiness or
  progress. Existing absent/false settings mean panes; stop the Team and create
  a new epoch with `team_create.separate_windows=true` to adopt windows—never
  edit config or pass a Worker override, and unsupported carriers refuse.

## Current status and anchors

- The public surface has ten tools, one versioned result envelope, and a read-only `/pi-team-bright [status|help]` command. Its internal diagnostic schema remains `pi-teams-status/1`; it reports Team/Membership, exact Session binding, configured storage, and Beads authority state without claiming Task, Worker, runtime, or progress state. The shared TUI receipt is a human projection: Accepted/Partial/Refused facts are separate from bounded italic model hints, while machine next actions remain expanded-only evidence.
- `@hypercarrier/pi-team-bright@0.16.0-rc.1` remains npm-unpublished. Its
  first public release requires the explicit human/2FA bootstrap; bind the
  trusted publisher immediately after that successful bootstrap, then later
  releases use the manually dispatched OIDC workflow.
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

## Constraints and open work

One live blocker remains below the recovered Worker lifecycle: ordinary
`team_sync` intermittently times out in the single underlying Beads `list`
command while live Workers settle Tasks. Task projection availability must be
isolated from valid Team/Worker carrier state, and any read retry must be
bounded, read-only, traceable, and tested under concurrent Beads/Dolt activity
rather than hidden by a larger timeout.

Next steps:

1. Reproduce the `bd list` contention with semantic traces and concurrent Task
   writes; determine whether Beads read-only mode, one bounded retry deadline,
   or both are supported by external evidence.
2. Make `team_sync` return a typed partial result when Task projection is
   unavailable, without misreporting zero Tasks or discarding valid Team and
   Worker carrier state.
3. Restart live Teams as one version epoch after an upgrade or rollback.
4. Reassess component stage at the next R&D kickoff. New experimental pieces
   may return to exploration without weakening anchors for the hardened core.


## Test lanes

`npm test` is the fast deterministic lane, not exhaustive. Use `npm run test:exhaustive-only` for excluded integration/contract/e2e and QA tests, `npm run test:full` for all tests, and `npm run test:lanes` to verify lane closure.
