# Canonical Task cutover implementation

Date: 2026-08-05
Task: `canonical-task-integration-rca`

The preserved candidate tree now has a neutral Task card contract in
`src/model-tool-contract/task-domain.ts`. Model and Worker Task cards use the
opaque `TaskVersionRef` projection. Delivery records persist the same card and
no longer persist authority IDs or native revisions in Task references.

The Worker Task read and update tools now execute the semantic adapter path
without a legacy receipt parser. Normal delivery, recovery, and owner-outbox
reads reject old records with `upgrade_required`. The stopped-epoch migration
in `src/utils/task-delivery-migration.ts` converts legacy snapshots with atomic
replacement and an idempotent bounded receipt.

The create operation keeps its required post-create authority hydration to
verify same-operation semantics and build the canonical card. Delivery receives
that card and adds zero authority calls. It does not use a legacy receipt parser
or a compatibility-field fallback.

Focused evidence:

- `npm run typecheck` passed.
- `npx vitest run src/model-tool-contract/canonical-task-cutover.acceptance.test.ts src/model-tool-contract/result-projection.test.ts src/model-tool-contract/task-update-version-ref.test.ts --pool=forks` passed 3 files and 14 tests.
- `git diff --check` passed.
- The active-runtime scan found no `taskSnapshot` or `committedTaskSnapshot`; those names exist only in the stopped-epoch migration module. Legacy records migrate through one scoped list and one adapter multi-ID read, then receive atomic replacement.

Architecture impact: `none`. The change narrows the Task projection and
persistence epoch. It does not change depicted components, dependencies, or
topology.
