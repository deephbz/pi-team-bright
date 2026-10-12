# Decision 0020: Hold the Team cursor on the lead's branch

Date: 2026-10-13
Status: accepted
Architecture impact: **changed** inside Pi Team Bright's observation persistence boundary. HyperCarrier's diagram keeps PTB internals opaque.
Supersedes: [Decision 0016](0016-framework-team-synchronization.md) delivery mechanics. Batch scheduling from 0016 remains in force.
Basis: [Proposal A](../journal/2026-10-12-state-ownership-and-liveness-proposal.md#proposal-a-the-leads-session-branch-holds-the-cursor); owner instruction of 2026-10-12 to implement the agreed v3.1 design ([implementation plan](../journal/2026-10-12-v31-implementation-plan.md)).

## Context

Decision 0016 advanced the lead's observation cursor only after exact presentation
evidence and a successful provider turn that contained a framework-fabricated
`team_sync` result. Framework sync therefore took part in the conversation
protocol. The provider-proof matcher covered five wire formats. One miss left the
cursor unacknowledged. Later syncs then replayed old events and superseded
projected history, which broke prompt-cache reuse. Blocking `team_sync` waits let
an operator's Escape look like Worker failure.

## Decision

- The lead's selected native Session branch holds the cursor. The cursor is the
  maximum `through` over `ptb.team-update` entries and `team_sync` results on
  `ctx.sessionManager.getBranch()`, scoped to the current Team epoch and the
  authorized lead binding.
- Delivery appends. It never rewrites or supersedes history.
- There is no provider acknowledgement. "Delivered" means a native entry exists on
  the branch. That is historical presentation. It does not prove current model
  knowledge; after compaction the lead requests a snapshot.
- `team_sync updates` reads from the branch cursor and returns at once. A missing
  branch cursor selects a snapshot, which captures its journal watermark before
  Task and Worker hydration.
- Automatic publication stays idle-only. An in-memory reservation owns one page
  until the native entry appears, a branch, Session, or binding change invalidates
  it, or a bounded failure timer fires. The timer releases only in-memory
  ownership and never advances the cursor.
- Removed: framework-sync record and acknowledgement entries, the provider-payload
  matcher, supersession, the hidden-observation store, the reader's use of
  `events/cursor.json`, and blocking waits inside `team_sync`.
- Kept: `operation_id` replay and version checks on writes, the compaction delivery
  gate, batch scheduling, and Worker-side Task delivery with its own
  acknowledgement, tombstones, and resume. The Worker-side acknowledgement is a
  Task-delivery record, not a provider acknowledgement. This decision changes only
  the lead observation cursor.
- The lead waits by ending its turn. A `ptb.team-update` resumes it.

## Consequences

- Delivery position belongs to the reader's own branch. A fork copies cursor
  entries into a new Session, which stays unbound, so copied entries never activate
  a Team.
- `/tree` to a point before an update recomputes the cursor from the selected
  branch and delivers the missed events.
- A held send dropped by the compaction gate is replayed from the branch cursor on
  the next read.
- Compaction removes the payload from model context but not from the branch. A
  snapshot restores current context.
- A snapshot is not an atomic cross-authority read. Newer Task state can appear
  early and repeat later.
- A failed automatic send suppresses retries until the branch changes. `/ptb sync`
  can retry.
- Authority-revision reconciliation stays. Task state can change without a journal
  event.

## Evidence that would reverse it

- Pi adds a public framework tool-execution API with persistence and ordering
  guarantees, which is Decision 0016's reversal condition. The branch-held cursor
  would still be the right location, so the publisher and reader would change, not
  the cursor's home.
- The branch cursor repeats a page in normal operation, or skips an event, in the
  branch-held verification cases: reservation contention, crash before persistence,
  compaction, `/tree` before an update, and fork.
- A snapshot cannot restore context after compaction in the real-Pi scenarios
  S1, S3, S5, or S6.
- The owner rules that a provider acknowledgement is required for correctness.

Executable evidence: [`sync-continuity.test.ts`](../../src/coordination/sync-continuity.test.ts),
[`team-update.test.ts`](../../extensions/team-update.test.ts), and the real-Pi
runner in [scenario verification](../maintainers/scenario-verification.md).
