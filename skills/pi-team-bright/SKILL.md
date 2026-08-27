---
name: pi-team-bright
description: Operate Pi Team Bright with long-lived Teams, durable assigned Tasks, reusable or ephemeral Workers, and event-driven Team synchronization.
---

# Pi Team Bright

Task plus assignee is the only work-delegation contract. Alerts are exceptional
coordination, and `team_sync` is the event-driven observation surface. Don't
poll runtime state, sleep, or inspect terminal output for normal progress.

## Topology and lifecycle

Team, Worker, and Task operate at different time scales. A Team follows one
project or durable coordination boundary. A Worker follows a coherent semantic
role or an intentionally isolated perspective. A Task follows one bounded
outcome. Never derive one lifecycle directly from another.

Reuse before creation. At the beginning of related work, restore the current
Team projection and reconcile current Workers before creating capacity. A new
request, terminal Task graph, empty ready front, or idle interval does not imply
a new or finished Team. Keep the Team alive until the owner or operator
explicitly ends its durable boundary or requests a lifecycle reset.

Use the minimum sufficient Worker frontier. Create a Worker only when it
unlocks parallel independent work, establishes a distinct reusable semantic
scope, or deliberately isolates context or perspective. Otherwise reuse a
suitable current Worker. Do not reuse one Worker so broadly that unrelated
domains pollute its context or independent work is unnecessarily serialized.

Preserve causal context. Implementation, execution, diagnosis, and repair
normally stay with one Worker. Independent review, verification, adversarial
analysis, and alternative experiments can use a fresh Worker even when their
Tasks depend on earlier work. Idle reusable Workers remain valid capacity.

## Operating protocol

1. For a new Team, call `team_create` before the first `team_sync`. `team_sync`
   does not discover or create a Team. In a resumed exact leader Session, use
   `team_sync({view:"snapshot"})` to restore its current projection.
2. Apply the topology policy before `ensure_worker`. A Worker scope is a role,
   never the current work item.
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
8. Stop an ephemeral or no-longer-useful Worker only after its nonterminal
   assigned Tasks resolve. Reconcile once more. Use `team_shutdown` only after
   the owner or operator explicitly ends the durable boundary or requests a
   lifecycle reset.

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
