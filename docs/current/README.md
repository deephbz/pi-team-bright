# PiTeams evergreen context

Updated: 2026-07-26

Lifecycle stage: **sharing candidate** for the Task-first coordination and
Membership-observation surfaces; the unresolved Beads list-contention path
remains in **hardening**.

This is the maintained context a new human or agent should read first. It
contains only intent, decisions still in force, current status, constraints,
and next steps. Executable contracts live in source and tests; dated attempts
and observations live in the [journal](../journal/).

## Product intent

PiTeams turns one Pi Session into the lead of a Team of stable Workers. A Task
plus its assignee is the only executable work contract. `team_sync` is the
event-driven observation and wait boundary. Typed Alerts are exceptional
clarification, attention, or announcement; they never assign, advance, block,
or complete work.

The product deliberately excludes a general agent directory, cross-Team
routing, freeform work-by-message, inbox polling, runtime polling as progress,
and terminal activity as Task evidence. Exact current Membership and Pi Session
binding determine who may act; matching names, processes, panes, or environment
variables do not.

PiTeams also answers one private operation-specific Rarebit policy query. It
inhibits automatic Summary synthesis only when locked TeamConfig evidence
proves that the queried durable Pi Session is the exact active binding of one
current teammate Membership generation. It abstains for leaders, standalone,
forked, resumed-but-unbound, replaced, ambiguous, or unverifiable identities.
Rarebit owns the versioned vocabulary, deadline, fail-open behavior, and
receipt; this is not a general provider registry and does not affect manual
Summary, deterministic Rarebits, Title, attention, health, or readiness.

## Current concept graph

This milestone diagram is the high-density interface view. The concrete type,
schema, and behavior sources are linked in the next section.

```mermaid
flowchart LR
  Lead["Team lead"] --> Lifecycle["team_create · worker_ensure · worker_stop · team_shutdown"]
  Lead --> Shared["Task tools · team_sync · alert_send"]
  Worker["Stable Worker"] --> Shared
  Task["Task + assignee + acceptance criteria"] --> Beads["Beads Task authority"]
  Worker --> Task
  Lifecycle --> Team["Team / Membership authority"]
  Beads --> Events["Team event journal"]
  Team --> Events
  Alert["Accepted Alert"] --> Events
  Events --> Sync["team_sync cursor / wait / projection"]
  Sync --> Agent["Agent semantic content"]
  Sync --> Machine["Machine result envelope"]
  Sync --> Human["Compact / expanded TUI"]
```

## Sources of truth

Each fact has one authoritative home; other documents point to it.

| Concern | Authority |
|---|---|
| Public tool selection and TUI renderer attachment | [`PI_TEAMS_PUBLIC_TOOLS`](../../src/utils/tool-result-renderer.ts) and [`extensions/index.ts`](../../extensions/index.ts) |
| Tool parameters, descriptions, guards, and execution | TypeBox registrations in [`extensions/index.ts`](../../extensions/index.ts) |
| Machine result schema | [`PiTeamsToolResultDetails`](../../src/utils/tool-results.ts) |
| Team, Membership, Task, Alert, and event types | [`src/utils/models.ts`](../../src/utils/models.ts) |
| Read-only Membership observation protocol | [`src/public/observation.ts`](../../src/public/observation.ts), exported as `pi-teams/observation` |
| Exact-teammate automatic-Summary inhibition evidence | [`src/utils/automatic-summary-policy.ts`](../../src/utils/automatic-summary-policy.ts) and [`src/utils/teams.ts`](../../src/utils/teams.ts) |
| Task authority and mutation semantics | [`src/utils/tasks.ts`](../../src/utils/tasks.ts) and [`src/utils/beads.ts`](../../src/utils/beads.ts) |
| Event cursor, wait, filtering, and paging semantics | [`src/utils/team-events.ts`](../../src/utils/team-events.ts) |
| Reuse-first lifecycle recommendations | [`src/utils/team-sync-actions.ts`](../../src/utils/team-sync-actions.ts) |
| Human operating introduction | [Repository README](../../README.md) |
| Agent operating procedure | [`skills/pi-teams/SKILL.md`](../../skills/pi-teams/SKILL.md) |
| Verification intent | Contract tests and the [headless QA harness](../../scripts/tool-result-qa/README.md) |

The [contract source map](../reference.md) gives one-hop navigation without
restating these executable definitions.

## Decisions still in force

- Assigned Tasks are the sole durable work-delegation protocol; Alerts remain
  exceptional coordination. See [decision 0003](../decisions/0003-task-first-coordination.md).
- The repository keeps one evergreen current-context document. Contract truth
  migrates into types, public schemas, and tests as the component consolidates;
  docs keep intent, rationale, and pointers. See
  [decision 0004](../decisions/0004-source-allocation.md).
- Task authority, Team/Membership authority, Pi Session identity, event
  evidence, delivery presentation, runtime observation, and terminal surfaces
  remain distinct. `pi-teams-observation/1` is recorded Membership evidence,
  never OS liveness; see [decision 0006](../decisions/0006-membership-observation-protocol.md).
- Team topology and lifecycle mutations are lead-only. Shutdown deactivates a
  Membership only after exact stop evidence. Task history and authority remain.
- One live Team runs one PiTeams version; upgrades happen as a stopped and
  restarted epoch, not a rolling deployment.
- A Team epoch owns one direct terminal carrier. An inherited outer terminal
  identity cannot validate a Worker running inside a nested multiplexer; see
  [decision 0005](../decisions/0005-direct-terminal-carriers.md).

## Current status and anchors

- The public surface has ten tools and one versioned result envelope.
- The headless suite emits 39 immutable cases across all public tools without
  launching Pi, a model, tmux, or the foreground TUI.
- The last baseline full repository run passed 44 test files and 349 tests. The
  direct-carrier hardening change passed `npm run typecheck`, 121 focused
  adapter/lifecycle/contract tests, and the isolated agent-surface snapshot;
  its concurrent full-suite run reached 401 passing tests before the
  5-second snapshot-test timeout, while that snapshot passes alone in 2.46s.
- `worker_ensure` now keeps carrier lifecycle independent of Task authority: it
  reuses a live carrier, retries the same unconsumed capability when a prepared
  carrier disappeared, or resumes the exact bound Session when a later carrier
  disappeared. Multi-Task projections use one batched Beads read, lifecycle
  guards hydrate only relevant nonterminal candidates, and direct Herdr launch
  tolerates the bounded split-to-shell readiness race. Live smokes preserved
  identities across both the prepared retry and exact-Session recovery paths,
  then delivered and closed post-recovery work; the complete full run passed
  all 50 files and 407 tests. Incident and validation evidence is retained in the
  [worker-recovery journal](../journal/2026-07-25-worker-recovery-and-task-hydration.md).
- Worker ensure now normalizes persisted optionals into an exhaustive carrier
  state and executes one typed plan; prepared and exact-Session recovery share
  one effect/compensation path, while authority-budget tests keep Task reads out
  of ensure and bound lifecycle projections.
- `pi-teams/observation` publishes the minimal `pi-teams-observation/1`
  Membership-evidence contract for read-only consumers. It exposes no Task or
  private collaboration content, performs no filesystem writes or producer
  locking, uses atomic runtime publication plus bounded coherent sampling, and
  has a packed plain-Node/declaration probe. Timeline independently accepted the
  final producer contract with no blockers; the integrated repository run
  passed all 53 files and 431 tests. Design and validation evidence is in the
  [combined hardening journal](../journal/2026-07-26-worker-contract-and-observation-protocol-plan.md).
- The publication candidate contains four semantic implementation commits:
  direct terminal authority, Worker Task completion, exact Task-independent
  carrier recovery, and Membership observation. Its packed-package probe plus
  all 53 files and 431 tests pass.

## Constraints and open work

One live blocker remains below the recovered Worker lifecycle: ordinary
`team_sync` intermittently times out in the single underlying Beads `list`
command while live Workers settle Tasks. The prior N+1 hydration defect is no
longer involved. Task projection availability must be isolated from valid
Team/Worker carrier state, and any read retry must be bounded, read-only,
traceable, and tested under concurrent Beads/Dolt activity rather than hidden by
a larger timeout.

Next steps:

1. Reproduce the `bd list` contention with semantic traces and concurrent Task
   writes; determine whether Beads read-only mode, one bounded retry deadline,
   or both are supported by external evidence.
2. Make `team_sync` return a typed partial result when Task projection is
   unavailable, without misreporting zero Tasks or discarding valid Team and
   Worker carrier state.
3. Prepare the next PiTeams version (the current package still identifies as
   `0.14.0-hypercarrier.0`), then push a reviewed release commit before any
   external repository records it as a submodule target.
4. Human-review the Task-first interface, terminal direct-carrier contract, and
   source allocation.
5. Merge and release only after review; restart live Teams as one version epoch.
   Any pre-change mixed-carrier Team must be stopped and recreated after
   release.
6. If HyperCarrier adopts a `packages/pi-teams` gitlink, explicitly revise its
   prior no-submodule decision and update npm-workspace, clone, lockfile, and
   public-export semantics rather than introducing those effects implicitly.
7. Reassess component stage at the next R&D kickoff. New experimental pieces
   may return to exploration without weakening anchors for the hardened core.

## Historical trail

- [Task-first problem and design](../journal/2026-07-17-task-first-agent-coordination-design.md)
- [Documentation source reallocation](../journal/2026-07-17-documentation-source-reallocation.md)
- [Task-first coordination decision](../decisions/0003-task-first-coordination.md)
- [Contract source map](../reference.md)
