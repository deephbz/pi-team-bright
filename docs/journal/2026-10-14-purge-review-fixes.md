# Graph-only review fixes

Base: `d26b676`, after the graph-only merge `7b44269`.
Scope: accepted purge and terminal-delivery review findings S1–S4, P1, P2,
P4, and F1. No publication or deployment occurred.

## Corrected invariants

- Registered graph mutations carry the actor's exact Membership and Session
  to the durable authority. The authority acquires the existing Membership
  mutation lease, rechecks the Session, and commits under the graph lock.
  It releases the Membership before downstream publication. A retired binding
  receives a refused result with unchanged Task state.
- Delivery currentness requires a readable graph. A derived fence or retained
  spool cannot authorize presentation. Presence checks run before graph-local
  locks can create a directory. Otherwise an unsupported store could acquire
  a false lost-graph marker from its own failed read.
- Targetless recovery persists its selected exact recipient before enqueue.
  A later replay retains that target after partial publication and replacement.
- Missing snapshots with retained graph markers require graph restoration.
  Obsolete backend fields cannot override those markers. Graphless unsupported
  stores retain their fixed refusal message.
- Registered stop and shutdown map graph-storage failures to the existing
  typed `unavailable` result with reason `team_authority_unavailable`.
  The existing schema and renderer already support this reason.
- Human terminal-delivery notices and status details include the accepted next
  action. Model-facing refusal text remains unchanged. Unsupported status omits
  graph paths and graph-operation advice.

## Verification anchors

- `src/utils/graph-mutation-membership.test.ts`: real registered Worker update,
  leader update, and graph apply pause at authority entry. Replacement,
  lifecycle shutdown, and changed Session bindings refuse the paused calls.
  A second schedule proves the commit holds the Membership lease. Registered
  stop and shutdown return typed unavailable outcomes on unsupported storage.
- `src/utils/graph-delivery-review.test.ts`: live scans refuse missing graphs
  with and without a valid derived fence and report background failure. Recovery
  refuses enqueue before target persistence and keeps one delivery ID after
  resolution failure plus same-name replacement. Status and missing-graph
  classification tests cover both storage cases.
- `src/model-tool-contract/durable-team-boundaries.test.ts`: durable creation
  precedes its callback; callback rejection preserves the Team; pane naming
  failure stays nonfatal; snapshot roles honor exact trust; registered Worker
  launch carries cwd, trust, and available model keys.
- `src/utils/graph-spool-history.test.ts`: successful-turn compaction retains
  pending records and suppression tombstones; more than 256 pending records
  and recovery markers survive; graph trace results omit payloads.
- Session-adapter characterization and delivery-retry projection tests preserve
  independent Alert delivery, one terminal notice, no retry, and unchanged model
  diagnostics.

The first aggregate run exposed six fixture groups that had relied on graphless
currentness. Their delivery and liveness assertions now use real graph state.
No production fallback or weaker assertion was added. Old trace assertions for
legacy backend command counts remain retired; the retained trace contract covers
semantic outcomes, lock timing, and payload exclusion.

Typecheck, fast Vitest (1,993 passed, 3 skipped), lane audit (164 fast and
24 exhaustive files), observation build, package verification, and tracked-dist
verification passed. The exhaustive release lane remains the lead's gate.
Architecture impact: **none**. These changes repair existing authority and
identity invariants. Component responsibilities and the public Membership
observation protocol remain unchanged.
