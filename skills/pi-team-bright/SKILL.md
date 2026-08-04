---
name: pi-team-bright
description: Operate Pi Team Bright with durable assigned Tasks, stable Workers, and event-driven Team synchronization.
---

# Pi Team Bright

Task plus assignee is the only work-delegation contract. Alerts are exceptional
coordination, and `team_sync` is the event-driven observation surface. Don't
poll runtime state, sleep, or inspect terminal output for normal progress.

## Operating protocol

1. For a new Team, call `team_create` before the first `team_sync`. `team_sync`
   does not discover or create a Team. In a resumed exact leader Session, use
   `team_sync({view:"snapshot"})` to restore its current projection.
2. Use `ensure_worker` only when no suitable current Worker exists. A Worker
   scope is a standing role, never the current work item.
3. Create assigned Tasks with explicit goals and independently verifiable
   success signals.
4. A Worker starts accepted work with an atomic claim. Send `claim=true` alone;
   don't combine it with status, context, or evidence changes. Use the returned
   Task version for the next update. The Worker verifies work, then closes with
   evidence or blocks with blocker evidence and a next action.
5. Use `team_sync({view:"updates"})` for routine supervision. Mutation receipts
   already contain post-state; don't immediately re-read them.
6. Treat a Beads timeout as an unknown authority outcome, not an empty Task set
   or proof of failure. Retry a timed-out read. After a mutation timeout, first
   read the current Task. If retry is still required, reuse the same operation
   ID and identical semantics with the current exact version. For Task creation,
   retry an `unknown_outcome` with the same operation ID and identical input.
7. Use `task_link` for typed graph relations and `alert_send` only for
   clarification, attention, or announcements. An Alert never changes a Task.
8. Reuse current Workers. Stop a Worker only after its nonterminal assigned
   Tasks are resolved. Reconcile once more, then use `team_shutdown`.

## Invariants

- Task and Team authorities own current state. Events wake observers but are
  not a second authority.
- Delivery acknowledgement proves presentation to one exact Session only; it
  never changes Task state.
- Team topology and lifecycle mutations are lead-only.
- Expected refusals and partial outcomes are semantic results. Follow their
  next action instead of treating them as infrastructure crashes.
- A snapshot establishes the hidden branch position. An updates result advances
  it only after Pi persists the model-visible result.
- Task updates require the exact opaque Task version ref and an operation ID.
  Identical retries replay the durable receipt; stale or conflicting writes refuse.
- Closed is a work state, not an immutable Task. Later evidence or relation
  writes can advance its version. Use the latest receipt or read before another
  conditional mutation.
- Provide `current_context` only when still-relevant Task meaning changes. Provide
  `journal_entries` for evidence or rationale. A status-only update is valid only
  when neither information class changes.
- Team lifecycle and terminal placement remain durable authorities. The public
  model surface does not expose carrier placement or backend controls.

## Recovery

Never mutate Team authority during normal operation. If `team_create` reports
an active Team while both `team_sync` and `team_shutdown` report no active
Team, stop and use the [last-resort stale Team rescue](references/team-rescue.md)
only with explicit owner authorization and exact absence evidence.

## Contract lookup

Pi presents each tool's executable schema and description directly. Treat
those schemas—not a duplicated parameter list here—as the source of truth.
Use the [contract source map](../../docs/reference.md) when implementation,
authority, event, or projection details are needed.
