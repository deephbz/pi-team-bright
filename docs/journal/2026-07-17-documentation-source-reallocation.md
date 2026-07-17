# Documentation source reallocation

Date: 2026-07-17

Status: historical change record

## Trigger

Agenciples commits `e1a7fc2` and `cd02d79` codified minimal agent interfaces,
single source of truth with fluid representation, an evergreen/journal split,
authored milestone diagrams, and stage-calibrated rigor. PiTeams had just
consolidated a ten-tool Task-first interface, but its maintained current pages
still described the earlier 18-tool Message/inbox surface.

## Observed evidence

- Executable TypeBox schemas and tool behavior live in
  [`extensions/index.ts`](../../extensions/index.ts).
- The exact public selection and human renderer boundary live in
  [`src/utils/tool-result-renderer.ts`](../../src/utils/tool-result-renderer.ts).
- Result, Task, and event contracts have stable TypeScript homes and contract
  tests.
- `docs/current/product.md`, `domain.md`, `system.md`, and `operations.md`
  duplicated one another and named removed public tools.
- `docs/reference.md` duplicated every parameter even though the schema was
  already executable and directly presented to agents.

## Interpretation

PiTeams is in hardening for this component. Contract truth should therefore
migrate from shaping/design prose into types, schemas, implementations, and
tests. Docs should retain intent, rationale, current judgment, and navigation.
The earlier multi-page allocation was correct for its consolidation milestone
but had become overdue rigor in the wrong medium.

## Change

- Collapsed maintained current context into one evergreen document with the
  lifecycle stage, current concept graph, decisions, status, constraints, and
  next steps.
- Replaced the exhaustive prose parameter reference with a source map.
- Added decisions for Task-first coordination and source allocation, marking
  the replaced decisions as superseded without rewriting their rationale.
- Removed stale current pages and compatibility pointer stubs; Git preserves
  them as historical source.
- Trimmed `AGENTS.md` to an entry-point router and the PiTeams skill to
  operating procedure and invariants; executable tool schemas remain the
  parameter authority.
- Updated package contents and contract tests to enforce pointers rather than
  duplicated prose schemas.

## Verification anchors

- Link audit with `rg` finds no active pointer to removed current pages.
- `npm run typecheck` and focused contract tests validate the executable
  boundary.
- The existing 39-case headless QA and 44-file repository suite remain the
  behavioral anchors for the Task-first implementation.

## Resulting records

- [Evergreen context](../current/README.md)
- [Source allocation decision](../decisions/0004-source-allocation.md)
- [Task-first decision](../decisions/0003-task-first-coordination.md)
- [Contract source map](../reference.md)
