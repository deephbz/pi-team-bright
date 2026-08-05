# Canonical Task strict-boundary repair

Date: 2026-08-05
Task: `canonical-task-integration-34t`

## Result

The preserved canonical Task cutover now has two strict residual repairs:

the delivery module no longer uses `effectiveVersion` or
`taskPublicationState`; it accepts an opaque `TaskVersionRef` and refuses a
raw revision before persistence. The semantic `tasks.ts` module is now a
canonical facade. Raw authority mutation code lives in
`task-authority-service.ts`, below the Beads adapter. Worker claim execution
uses `CandidateBeadsTaskAdapter.claim`, so the extension no longer reads raw
authority records or projects them for claim results.

The adapter remains the only source that translates authority records and
candidate metadata. Delivery records and Task changes keep only the canonical
card and opaque version coordinates. Existing stopped-epoch migration support
remains separate and unchanged.

## Evidence

- `npm run typecheck` passed.
- Focused Vitest passed 5 files and 41 tests:
  `canonical-task-cutover.acceptance.test.ts`, `beads-task-adapter.test.ts`,
  `result-projection.test.ts`, `task-update-version-ref.test.ts`,
  `task-delivery.test.ts`, and `owner-transition-outbox.contract.test.ts`.
  The lane passed 41 tests.
- The acceptance test reads source literally: `tasks.ts` contains no raw
  authority type definition or `BeadsTaskStore` construction, delivery contains
  no `effectiveVersion` or `taskPublicationState`, and the adapter owns the raw
  authority type.
- `git diff --check` passed.

Architecture impact: `none` to the depicted topology. This changes an
internal responsibility boundary between the semantic facade, adapter, and
delivery code. It changes no component identity, dependency direction in the
canonical Structurizr view, deployment topology, or trust boundary.
