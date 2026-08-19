---
name: pi-team-bright
description: Operate Pi Team Bright with long-lived Teams, durable assigned Tasks, reusable or ephemeral Workers, and event-driven Team synchronization.
---

# Pi Team Bright

Task plus assignee is the only work-delegation contract. Alerts are exceptional
coordination, and `team_sync` is the event-driven observation surface. Don't
poll runtime state, sleep, or inspect terminal output for normal progress.

## Operating protocol

1. Align one long-lived Team identity with one project or durable coordination
   boundary. Reuse that Team for related work; don't create or shut down a Team
   for each Task. For a new Team, call `team_create` before the first `team_sync`.
   `team_sync` does not discover or create a Team. In a resumed exact leader
   Session, use `team_sync({view:"snapshot"})` to restore its current projection.
2. Use `ensure_worker` only when no suitable current Worker exists. A Worker can
   be reusable capacity for a standing semantic area or ephemeral capacity for
   bounded work. Its scope is a role, never the current work item.
3. Create one atomic Task DAG with request-local keys, explicit goals, success signals,
   and stable Worker assignees. Put prerequisite keys in each Task's `needs` list.
   One Task is the one-node case. If order matters, encode it with `needs`.
4. Task authority presents the ready front mechanically, with at most one Task
   per Worker. A Worker sends `claim` with the exact Task version before work.
   Use the returned version for the next command. Send `goal_achieved` with
   external success evidence, or `goal_failed` when criteria fail. Task authority
   applies any bounded failure edge. Use `block` only for an external blocker,
   and include blocker evidence.
5. Use `team_sync({view:"updates"})` for routine supervision. Mutation receipts
   already contain post-state; don't immediately re-read them.
6. Treat a Beads timeout as an unknown authority outcome, not an empty Task set
   or proof of failure. Retry a timed-out read. After a mutation timeout, first
   read the current Task. If retry is still required, reuse the same operation
   ID and identical semantics with the current exact version. For Task creation,
   retry an `unknown_outcome` with the same operation ID and identical input.
7. Put request-local prerequisite keys in `tasks[].needs`. There is no separate
   model-facing link tool. Use `alert_send` only for clarification, attention, or announcements.
   An Alert never changes a Task.
8. Reuse a current Worker while its scope remains useful. Stop an ephemeral or
   no-longer-useful Worker only after its nonterminal assigned Tasks are
   resolved. Reconcile once more. Use `team_shutdown` only when the project or
   durable coordination boundary ends, or when an explicit lifecycle reset is
   required.

## Invariants

- Task and Team authorities own current state. Events wake observers but are
  not a second authority.
- Delivery acknowledgement proves presentation to one exact Session only; it
  never changes Task state. Explicit Worker claim accepts responsibility.
- Task authority derives readiness from current prerequisite states. It reserves
  one execution slot per Worker and advances successors without a leader turn.
- Team topology and lifecycle mutations are lead-only.
- Expected refusals and partial outcomes are semantic results. Follow their
  next action instead of treating them as infrastructure crashes.
- A snapshot establishes the hidden branch position. An updates result advances
  it only after Pi persists the model-visible result.
- Task updates require the exact opaque Task version ref and an operation ID.
  Identical retries replay the durable receipt; stale or conflicting writes refuse.
- `dependency_waiting` and `ready` are derived. Only `goal_achieved` satisfies a
  prerequisite. `goal_failed` and `cancelled` never release a success edge.
- Provide `current_context` only when still-relevant Task meaning changes. Use
  transition `evidence` for blockers, goal outcomes, and cancellation reasons.
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
