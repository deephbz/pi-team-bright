# Separate current context, decisions, and journal evidence

Status: superseded in part by [decision 0004](0004-source-allocation.md)

Date: 2026-07-16

Kind: documentation information architecture

## Context

PiTeams documentation had accumulated current contracts beside superseded
plans, research, manual test scripts, and release snapshots. That made stale
instructions look current and required readers to infer which document carried
a live claim.

## Decision

- `docs/current/` contains concise, maintained context: product scope, domain,
  system boundaries, and operating workflow. It may be corrected when source,
  tests, or an accepted decision change.
- `docs/reference.md` is the single exhaustive public tool and parameter
  contract. The README is an overview and quick start; it does not duplicate
  the reference.
- `docs/decisions/` contains accepted, numbered choices. A later reversal is a
  new decision that links to the earlier one rather than rewriting its
  rationale.
- `docs/journal/` contains dated, append-only observations and change records.
  A journal entry is historical evidence and does not become current contract
  merely because it is recent.
- Superseded loose documentation is removed from the active tree. Its original
  source remains recoverable through version control; current pages and the
  journal retain only the evidence needed to navigate the present contract.

## Consequences

Readers can start with current context, trace material choices to decisions,
and inspect dated change evidence without treating old experiments as current
instructions. Maintaining a current claim now requires an explicit source or
test check.

## Reversal conditions

Revisit this layout if real use shows that these record classes create more
navigation cost than they remove, or if a simpler structure preserves the same
separation between current contract, accepted choice, and historical evidence.

## Evidence

- [Current context](../current/README.md)
- [Documentation reorganization journal](../journal/2026-07-16-documentation-reorganization.md)
- [Public tool reference](../reference.md)
