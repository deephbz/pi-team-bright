# Make assigned Tasks the sole work protocol

Status: accepted

Date: 2026-07-17

Kind: product interface

Supersedes: [decision 0002](0002-team-scoped-communication.md)

## Context

The earlier public surface presented direct Message, broadcast, inbox, Task,
runtime inspection, and lifecycle tools as peer coordination paths. In real
long-horizon use, leads polled terminals, delegated work through freeform
messages, created replacement teammates instead of reusing stable roles, and
lost Task completion evidence.

## Decision

An assigned Task is the only executable work contract. A stable Worker carries
Tasks; replaceable Membership and Pi Session generations carry the Worker.
`team_sync` provides current projection, incremental events, and blocking wait.
One typed Alert operation remains for exceptional clarification, attention, or
announcement, but an Alert never assigns or mutates Task work state.

The exact public selection and schemas are executable sources, linked from the
[contract source map](../reference.md), rather than restated here.

## Consequences

Leads have one durable delegation path and one event-driven observation path.
Workers must advance, close, or block the Task with evidence rather than reply
only in a TUI. Runtime and presentation evidence remain available for
diagnosis but cannot substitute for Task authority.

The former Team-scoped Message decision remains historical evidence of the
superseded interface; the authorization insight survives as exact current-Team
Membership resolution for Alerts and native delivery.

## Reversal conditions

Revisit only if a concrete workflow cannot be represented as a goal-driven
Task or exceptional Alert and supplies an equally small, durable authority and
verification contract.

## Evidence

- [Problem and design](../journal/2026-07-17-task-first-agent-coordination-design.md)
- [`PI_TEAMS_PUBLIC_TOOLS`](../../src/utils/tool-result-renderer.ts)
- [Headless QA harness](../../scripts/tool-result-qa/README.md)
