# PiTeams contract source map

PiTeams is in hardening. Exact contract truth therefore lives in executable
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
- [`src/utils/tool-surface.test.ts`](../src/utils/tool-surface.test.ts) verifies
  the ten-tool selection and the irreducible Task, Worker, sync, and Alert
  distinctions.

## Result and projection contract

- [`PiTeamsToolResultDetails`](../src/utils/tool-results.ts) is the versioned
  machine-recorded envelope for accepted, partial, and refused outcomes.
- [`formatPiTeamsToolResult`](../src/utils/tool-result-renderer.ts) produces the
  compact and expanded human projections without serializing machine state as
  UI text.
- Agent content, machine details, and human rendering are projections of the
  same authoritative operation. The [Task-first design](journal/2026-07-17-task-first-agent-coordination-design.md#2-human-facing-tui-elements)
  records why they deliberately differ.

## Domain and authority

- [`src/utils/models.ts`](../src/utils/models.ts) owns Team, Membership, Task,
  Alert, delivery, runtime, and event types.
- [`src/utils/teams.ts`](../src/utils/teams.ts) owns Team configuration and
  current Membership generations.
- [`src/utils/tasks.ts`](../src/utils/tasks.ts) and
  [`src/utils/beads.ts`](../src/utils/beads.ts) own Task reads, mutations,
  relations, versions, evidence guards, and Beads authority integration.
- [`src/utils/team-events.ts`](../src/utils/team-events.ts) owns cursor ordering,
  waits, filters, bounded pages, and snapshot continuations.
- [`src/utils/alerts.ts`](../src/utils/alerts.ts) owns typed exceptional Alert
  acceptance and event publication.
- [`src/adapters/terminal-registry.ts`](../src/adapters/terminal-registry.ts)
  selects the terminal lifecycle adapter; adapter implementations own their
  platform capabilities and stop evidence.

## Verification and reproduction

- `npm run typecheck` checks the executable type contract.
- `npm test` runs unit, contract, lifecycle, identity, and integration tests.
- `npm run qa:tool-results` captures 39 immutable agent/machine/TUI cases with
  real Team and Beads state but no Pi, model, tmux, or foreground TUI.
- A tester agent judges information sufficiency and excess from the versioned,
  provider-neutral bundle. The harness, rubric, and historical scenario catalog
  live in [`scripts/tool-result-qa/`](../scripts/tool-result-qa/).

For human setup and a minimal example, start at the [repository README](../README.md).
For current stage, decisions, constraints, and next steps, read the
[evergreen context](current/README.md). Historical plans and observations stay
in the [journal](journal/).
