---
name: pi-teams
description: Operate PiTeams with durable assigned Tasks, stable Workers, and event-driven Team synchronization.
---

# PiTeams

Task plus assignee is the only work-delegation contract. Alerts are exceptional
coordination, and `team_sync` is the event-driven observation surface. Don't
poll runtime state, sleep, or inspect terminal output for normal progress.

## Operating protocol

1. Create the Team, then use `team_sync({view:"snapshot"})` to inspect its
   current projection.
2. Use `ensure_worker` only when no suitable current Worker exists. A Worker
   scope is a standing role, never the current work item.
3. Create assigned Tasks with explicit goals and independently verifiable
   success signals.
4. A Worker starts accepted work, verifies it, then closes with evidence or
   blocks with blocker evidence and a next action.
5. Use `team_sync({view:"updates"})` for routine supervision. Mutation
   receipts already contain post-state; don't immediately re-read them.
6. Use `task_link` for typed graph relations and `alert_send` only for
   clarification, attention, or announcements. An Alert never changes a Task.
7. Reuse current Workers. Stop a Worker only after its nonterminal assigned
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
- Provide `current_context` only when still-relevant Task meaning changes. Provide
  `journal_entries` for evidence or rationale. A status-only update is valid only
  when neither information class changes.
- Team lifecycle and terminal placement remain durable authorities. The public
  model surface does not expose carrier placement or backend controls.

## Contract lookup

Pi presents each tool's executable schema and description directly. Treat
those schemas—not a duplicated parameter list here—as the source of truth.
Use the [contract source map](../../docs/reference.md) when implementation,
authority, event, or projection details are needed.
