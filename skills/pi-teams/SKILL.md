---
name: pi-teams
description: Operate PiTeams with durable assigned Tasks, stable Workers, and event-driven Team synchronization.
---

# PiTeams

Task plus assignee is the only work-delegation contract. Alerts are exceptional
coordination, and `team_sync` is the event-driven observation surface. Don't
poll runtime state, sleep, or inspect terminal output for normal progress.

## Operating protocol

1. Create the Team, then sync without a cursor to inspect its current
   projection.
2. Ensure a Worker only when no suitable current Worker exists. A Worker
   profile is a standing role, never the current work item.
3. Create an assigned Task with an explicit goal and independently verifiable
   acceptance criteria.
4. A Worker starts accepted work, verifies it, then closes with evidence or
   blocks with blocker evidence and a next action.
5. Wait with the returned sync cursor and a positive wait duration. Mutation
   receipts already contain post-state; don't immediately re-read them.
6. Use Alerts only for clarification, attention, or announcements. An Alert or
   TUI reply never assigns, advances, blocks, or completes work.
7. Reuse current Workers. Stop a Worker only after its nonterminal assigned
   Tasks are resolved. Reconcile once more, then shut down the Team.

## Invariants

- Task and Team authorities own current state. Events wake observers but are
  not a second authority.
- Delivery acknowledgement proves presentation to one exact Session only; it
  never changes Task state.
- Team topology and lifecycle mutations are lead-only.
- Expected refusals and partial outcomes are semantic results. Follow their
  next action instead of treating them as infrastructure crashes.
- Reconcile pagination or continuation before waiting again; never silently
  regress a cursor.
- Team window placement is epoch policy: absent/false `separate_windows` means
  panes. Stop a Team before creating a new windows epoch with
  `team_create({ separate_windows: true })`; never edit config or supply a
  per-Worker window override. Unsupported carriers refuse the policy.

## Contract lookup

Pi presents each tool's executable schema and description directly. Treat
those schemas—not a duplicated parameter list here—as the source of truth.
Use the [contract source map](../../docs/reference.md) when implementation,
authority, event, or result-envelope details are needed.
