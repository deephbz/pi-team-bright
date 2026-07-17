# Keep one evergreen context and executable contract sources

Status: accepted

Date: 2026-07-17

Kind: documentation source allocation

Supersedes in part: [decision 0001](0001-documentation-records.md)

## Context

Decision 0001 correctly separated current context, decisions, and journal
evidence, but allocated current truth across four maintained pages and made a
prose reference the exhaustive public parameter contract. After the Task-first
surface stabilized, those pages still described the retired 18-tool Message
and inbox interface while the executable schemas had moved on.

At hardening, duplicated API, state, and event specifications are liabilities:
types, schemas, implementations, and tests are executable and verifiable;
prose copies are not.

## Decision

- `docs/current/README.md` is the sole evergreen current-context document. It
  declares component stage, decisions still in force, current status,
  constraints, blockers, next steps, and one milestone concept diagram.
- Exact tool, type, result, Task, event, and lifecycle contracts live in their
  TypeScript modules and tests. `docs/reference.md` is a one-hop source map,
  not a second schema.
- The repository README is the human entry point and minimal setup example.
  The PiTeams skill is agent operating procedure. Neither duplicates every
  tool parameter.
- Numbered decisions preserve durable rationale and explicit supersession.
  Dated plans, observations, attempts, measurements, and screenshots remain
  append-only journal evidence.
- Docs and code point to each other at the principal public boundaries.

## Consequences

Current sessions boot from one short maintained artifact. Parameter or event
changes require one executable edit plus tests, not synchronized prose edits.
Historical design detail remains available without masquerading as current
contract. Package consumers receive the README, evergreen context, source map,
source, and skill.

## Reversal conditions

Split the evergreen document only if demonstrated navigation or ownership
needs outweigh the stale-copy risk. Restore generated parameter documentation
only if it is derived mechanically from executable schemas and cannot diverge.

## Evidence

- [Current evergreen context](../current/README.md)
- [Contract source map](../reference.md)
- [Source reallocation journal](../journal/2026-07-17-documentation-source-reallocation.md)
- [`src/utils/tool-surface.test.ts`](../../src/utils/tool-surface.test.ts)
