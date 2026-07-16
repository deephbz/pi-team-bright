# Documentation reorganization

Date: 2026-07-16

Status: historical change record

## Trigger

The active documentation needed to match the current implementation, expose
its Team-scoped communication boundary, and stop presenting superseded
workflows as current instructions.

## Observed evidence

- The extension registers 18 public tools in
  [`extensions/index.ts`](../../extensions/index.ts).
- Direct Message and broadcast recipients are resolved from the current roster
  of the named Team in [`src/utils/messaging.ts`](../../src/utils/messaging.ts).
- The current Task model, statuses, authority projection, and version contract
  are defined in [`src/utils/models.ts`](../../src/utils/models.ts) and
  [`src/utils/tasks.ts`](../../src/utils/tasks.ts).
- Existing loose plans, research notes, compatibility snapshots, and manual
  test scripts described removed tools, retired Task states, or outdated
  release assumptions.

## Interpretation

The repository needed separate projections for maintained current context,
accepted choices, and historical change evidence. The communication boundary
was already enforced by the implementation but was not stated as a product
scope rule.

## Change

Created `docs/current/` for the maintained product, domain, system, and
operations context; added decisions for the record model and Team-scoped
communication; and made this journal the dated evidence of the reorganization.
Reduced the README to an overview and quick start, retained the reference as
the exhaustive tool contract, and replaced former guide/footer locations with
pointers to maintained pages. Removed superseded loose documentation from the
active tree; version control preserves the original source records.

## Open questions

- Keep the current pages concise as future features land; add a new decision
  only for durable product or contract choices.
- Revisit the communication boundary only when a concrete broader workflow has
  a specified identity, authorization, and delivery contract.

## Resulting records

- [Current context](../current/README.md)
- [Documentation record decision](../decisions/0001-documentation-records.md)
- [Team-scoped communication decision](../decisions/0002-team-scoped-communication.md)
