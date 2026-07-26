# Pi Team Bright contract source map

Pi Team Bright is in hardening. Exact contract truth therefore lives in executable
types, schemas, implementations, and tests rather than a second prose copy.
This page is a one-hop map to those sources; it is intentionally not an
exhaustive parameter reference.

## Public agent interface

- [`PI_TEAMS_PUBLIC_TOOLS`](../src/utils/tool-result-renderer.ts) is the exact
  public tool selection and the shared TUI-renderer boundary.
- [`extensions/index.ts`](../extensions/index.ts) owns each tool's TypeBox
  parameter schema, agent-facing description, authorization, execution, and
  semantic result content.
- [`skills/pi-teams/SKILL.md`](../skills/pi-teams/SKILL.md) is operating
  procedure, not another schema. Pi presents the executable tool schemas to the
  agent directly.
- [`src/utils/tool-surface.test.ts`](https://github.com/deephbz/pi-team-bright/blob/main/src/utils/tool-surface.test.ts)
  verifies the ten-tool selection and the irreducible Task, Worker, sync, and
  Alert distinctions.

## Read-only status diagnosis

- [`src/utils/team-status.ts`](../src/utils/team-status.ts) owns the `pi-teams-status/1` read-only TeamConfig/Beads diagnostic model and human projection.
- [`extensions/index.ts`](../extensions/index.ts) registers `/pi-team-bright [status|help]`; it has no `/pi-teams` alias.

## Result and projection contract

- [`PiTeamsToolResultDetails`](../src/utils/tool-results.ts) is the versioned
  machine-recorded envelope for accepted, partial, and refused outcomes.
- [`formatPiTeamsToolResult`](../src/utils/tool-result-renderer.ts) produces the
  compact and expanded human projections without serializing machine state as
  UI text.
- Agent content, machine details, and human rendering are projections of the
  same authoritative operation. The renderer keeps bounded model hints distinct
  from receipt facts and exposes `nextActions` only in expanded machine evidence.

## Domain and authority

- [`src/utils/models.ts`](../src/utils/models.ts) owns Team, Membership, Task,
  Alert, delivery, runtime, and event types.
- [`@hypercarrier/pi-team-bright/observation`](../src/public/observation.ts) exports the one
  read-only `pi-teams-observation/1` projector, canonical types, and JSON
  Schema; its authority and privacy boundary are enforced by that executable
  contract.
- [`src/utils/teams.ts`](../src/utils/teams.ts) owns Team configuration and
  current Membership generations.
- [`src/utils/automatic-summary-policy.ts`](../src/utils/automatic-summary-policy.ts)
  answers only Rarebit's versioned automatic-Summary inhibition query, using
  the exact current teammate Membership-generation and durable-Session resolver
  in `teams.ts`; it exposes no general policy registry.
- [`src/utils/tasks.ts`](../src/utils/tasks.ts) and
  [`src/utils/beads.ts`](../src/utils/beads.ts) own Task reads, mutations,
  relations, versions, evidence guards, and Beads authority integration.
- [`src/utils/team-events.ts`](../src/utils/team-events.ts) owns cursor ordering,
  waits, filters, bounded pages, and snapshot continuations.
- [`src/utils/worker-startup-observation.ts`](../src/utils/worker-startup-observation.ts)
  owns the bounded exact-Membership startup observation used after a new or
  recovered carrier launch; `session_bound` generation evidence correlates the
  exact runtime process tuple, and it is not a readiness or progress protocol.
- [`src/utils/alerts.ts`](../src/utils/alerts.ts) owns typed exceptional Alert
  acceptance and event publication.
- [`src/adapters/terminal-registry.ts`](../src/adapters/terminal-registry.ts)
  selects the terminal lifecycle adapter; adapter implementations own their
  platform capabilities and stop evidence.

## Verification and reproduction

- `npm run typecheck` checks the executable type contract.
- `npm test` runs only the fast deterministic lane; `test:exhaustive-only` is
  its CI complement, `test:full` runs all tests, `test:external` is the real
  Beads/Dolt diagnostic subset, `qa:agent-surface` is the artifact lane,
  `qa:tool-results` is receipt QA, and `test:lanes` checks closure.
- `npm run verify:package` packs the public artifact and probes the scoped
  observation import from a clean temporary project.

For human setup and a minimal example, start at the [repository README](../README.md).
For current stage, decisions, constraints, and next steps, read the
[evergreen context](current/README.md).


## Test lanes

`npm test` is fast and non-exhaustive; `test:exhaustive-only` is its CI complement, `test:full` runs everything, and `test:lanes` verifies closure. Use `test:external` for real Beads/Dolt diagnostics, `qa:agent-surface` for the agent-surface artifact, and `qa:tool-results` for receipt QA. CI on Node 22/24 runs fast plus the complement and package verification; publishing on Node 24 runs full plus package verification.
