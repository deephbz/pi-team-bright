# Decision 0024: Graph-only Task authority; remove Beads, Dolt and TLA+

Date: 2026-10-13
Status: accepted (owner decision 2026-10-13)
Architecture impact: **changed**. Task authority selection, Team creation and Worker delivery startup change. `docs/current` records the new contracts.

## Context

PTB moved Task authority to the graph store (`task-authority/graph-control.json`).
Beads stayed as the legacy authority and read fallback until a Team's first
graph apply. Every new Team still created an embedded Beads/Dolt workspace,
and Worker delivery startup still ran `bd list` against it.

The Linux scale run (4 leads x 25 Workers, 2026-10-13) showed the cost: a
Dolt lock timeout at startup stopped delivery for 2 of 100 Workers until a
human reloaded them. The stores were empty.

The TLA+ models under `formal/` were stale. The checker and the simulator
replaced them.

A read-only inventory of the owner's stores found 246 Teams whose Beads store
holds Tasks (2,987 Tasks, 389 not closed). None of them has graph authority.
No lead Session of these Teams was active in the 14 days before the inventory.

## Decision

1. PTB 0.24 supports only graph Task authority.
2. `team_create` writes an explicit empty graph snapshot. It creates no Beads
   workspace and records no Beads fields.
3. Every Task read, transition, guard, view and delivery path uses the graph.
   Worker delivery startup keeps the graph-owned recovery of publication
   records. It never runs `bd`.
4. Support for Teams that keep their Tasks in Beads ends. PTB does not export,
   migrate or read their Tasks. PTB never deletes their files. A Task
   operation on such a Team fails closed with a message that names the cause.
5. A Team with graph authority and old Beads fields uses the graph and ignores
   those fields.
6. A missing or corrupt graph in a graph Team is unavailable. It is never an
   empty Task list.
7. PTB removes the Beads adapters, the `@beads/bd` dependency (with its
   embedded Dolt), the binary setup scripts, the legacy Task migration
   commands, the `formal/` models and their CI job.

## Consequences

- No Dolt lock or `bd` process can affect Team creation or Worker startup.
- The code base loses about 9,000 lines of legacy code and tests.
- The 246 Beads Teams cannot run under 0.24. Their `.beads/` data stays on
  disk and remains readable with an external `bd` binary.
- Historical decisions and journals keep their Beads and TLA+ references as
  evidence.

## Evidence that would reverse this

- A supported user needs to continue work in a Beads-backed Team. Then add a
  one-way migration into graph authority as a separate change.

## Sources

- Owner direction, 2026-10-13: purge all legacy before 0.24 stable; drop
  support for Beads Teams completely.
- Inventory `purge-inventory` and the product and systems shaping reviews,
  2026-10-13 (private evidence).
- `docs/journal/2026-10-13-linux-real-scale.md` (finding F1).
