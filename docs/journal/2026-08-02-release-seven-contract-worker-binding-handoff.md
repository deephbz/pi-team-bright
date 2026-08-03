# Release seven-contract and Worker-binding handoff

Date: 2026-08-02

Task: `pi-team-bright-full-release-e2e-2rt` in Team `pi-team-bright-full-release-e2e`.
Branch: `preview/new-model-tool-surface`.

## Contract

Preserve all seven named test files and their scenarios. Translate old leader
calls and envelopes to the accepted ten-tool leader surface. Keep true Worker
fixtures explicit on the three-tool Worker surface. Do not run broad suites,
package gates, commits, pushes, or publication.

Seven files:

- `src/utils/binding-correctness.external.test.ts`
- `src/utils/ergonomic-tool-contract.test.ts`
- `src/utils/task-surface-cleancut.e2e.test.ts`
- `src/utils/launch-compensation.contract.test.ts`
- `src/utils/topology-lifecycle.contract.test.ts`
- `src/utils/clean-cut-contract.test.ts`
- `src/utils/clean-cut-round2.test.ts`

## Current progress

The accepted candidate runtime has ten leader tools and three Worker tools.
`worker_ensure` must not return to the leader surface. `TeamConfig` has the
implementation-version fence, and generated `dist/utils/models.d.ts` contains
`implementationVersion`.

Previous focused work passed typecheck, lane validation, QA, release P1,
team-owned authority, launch compensation, and topology checks. The Worker
receipt at `docs/journal/artifacts/2026-08-02-durable-preview-local-canary.json`
records distinct leader and Worker Sessions, distinct Membership generations,
Herdr carrier evidence, and a matching runtime generation. A new Luna slice is
still required by Task 2rt.

For the current Task 2rt pass:

- A focused run of all seven files was executed. It reported 36 failures.
- `src/utils/ergonomic-tool-contract.test.ts`,
  `src/utils/launch-compensation.contract.test.ts`, and
  `src/utils/topology-lifecycle.contract.test.ts` still use old leader
  `worker_ensure` references and old envelopes. Names were mechanically changed
  to `ensure_worker`; scope fields replaced old profile fields; implementation
  version setup was added to selected direct Team fixtures.
- `src/utils/task-surface-cleancut.e2e.test.ts` now has candidate schema input
  normalization in its leader harness, the implementation-version fence, and
  candidate task-create schema expectations. It still needs full raw-result
  translation without removing its behavioral assertions.
- `src/model-tool-contract/executors.ts` now accepts legacy-shaped direct test
  arguments as an internal normalization aid while Pi schemas remain the
  accepted candidate schemas. It normalizes old Team, Worker, and Task-create
  input shapes.
- `src/utils/clean-cut-contract.test.ts`,
  `src/utils/clean-cut-round2.test.ts`, and
  `src/utils/binding-correctness.external.test.ts` still need role/name and
  candidate-envelope translation.
- The connected Worker launch failure is not fixed yet. The known failure is a
  Luna leader and spawned Worker loading the same checkout wrapper through
  `-e` and `PI_TEAM_BRIGHT_SHIPPED_EXTENSION`; after 18 snapshots,
  `ensure_worker` remains `starting` and no Worker Session/runtime binds.
  Compare argv, inherited environment, wrapper loading, `session_start`, the
  implementation fence, and runtime admission with the passing a23070e
  two-Session canary. Do not lengthen polling or claim readiness.

## Verification boundary

Only run the seven named files, `npm run typecheck`, and one connected-Worker
Luna slice for Task 2rt. Do not run the broad suite, package gates, or publish.
Do not commit or push. Close the Task only after all seven files pass with
scenario counts preserved, the connected Worker Session and matching runtime
are observed, and Worker cleanup succeeds. Otherwise block with exact evidence.
