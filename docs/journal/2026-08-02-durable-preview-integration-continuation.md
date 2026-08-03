# Durable preview integration continuation

Date: 2026-08-02
Status: implementation in progress; preserve this handoff before compaction.

## Accepted route

Task `pi-team-bright-new-surface-e2e-nks` now requires direct integration into
`extensions/index.ts` on `preview/new-model-tool-surface`. Do not keep or add a
separate preview extension or runner. Version control and local installation
select the preview. The real extension must expose one role-correct surface:
leader processes receive the six candidate tools; preview-launched Workers keep
the current Worker Task surface over the shared Team/Beads authority.

## Completed in this turn

- Extended candidate result contracts for typed `contract_gap` outcomes in
  Task reads, Task updates, and Team sync; added typed unavailable outcomes for
  durable create/Worker paths.
- Added candidate metadata parsing export in
  `src/model-tool-contract/beads-task-adapter.ts`.
- Added preview Worker marker constant at
  `src/model-tool-contract/preview-constants.ts`.
- Extended `WorkerLaunchBridge` with launch environment injection and routed
  the marker to launched Workers.
- Added the marker-aware current Worker `task_update` path in
  `extensions/index.ts`: when valid candidate metadata exists and the marker is
  present, append_note/status mutations refresh candidate current_context and
  publish structured evidence in the same Beads write. Legacy/default Teams
  keep existing behavior.
- Added `setLeaderSessionFile` support in model-tool registration so durable
  adapters can bind candidate calls to the exact Pi Session file.
- Added an initial durable adapter at
  `src/model-tool-contract/durable-preview-port.ts`. It delegates Team and
  logical Worker authority to `teams.ts`, candidate Tasks to
  `CandidateBeadsTaskAdapter`, events to `team-events.ts`, and baselines to
  `hidden-observation.ts`; it uses `WorkerLaunchBridge` for real carriers.
- Added a temporary dedicated preview entry and runner under
  `scripts/model-tool-preview/`. The latest accepted Task supersedes these:
  do not retain a parallel preview implementation. Reuse useful logic only
  while moving selection into `extensions/index.ts`.

## Verification before the route change

`npm run typecheck` passed after the contract and durable adapter changes.
Focused foundation tests passed earlier: 29 tests across catalog, first
journey, candidate Beads adapter, hidden observation, and Team authority.
The temporary preview entry compiled with its temporary tsconfig. A real
multi-Session workflow has not run. The temporary runner has not been
verified. Do not claim those artifacts or workflow as complete.

## Immediate continuation

1. Re-read the current Task and current `extensions/index.ts` after compaction.
2. Remove the temporary `scripts/model-tool-preview/` entry, runner, and
   tsconfig, unless a useful test fixture is needed and the owner explicitly
   accepts it; the accepted route says no parallel preview implementation.
3. Integrate `DurablePreviewTeamPort` into `extensions/index.ts` behind the
   branch-local role selection. Unbound/bound leaders must register only the
   candidate six-tool surface; Worker processes must retain the shipped surface.
   Never register colliding old and candidate names in one Pi process.
4. Ensure the real extension passes the Worker marker and uses the extracted
   launch bridge. Keep current Worker task delivery and marker-aware metadata
   refresh behavior.
5. Add only focused direct checks needed for the integrated extension.
6. Run one real two-Session workflow on the shared Beads authority. Evidence
   must show distinct leader/Worker Session identities, one Team epoch,
   logical Worker scope, one authority fingerprint, real carrier observation,
   one assigned Task, Worker-authored structured Task evidence, one grouped
   leader update, and the candidate leader CAS/replay contract gap.
7. Create a redacted receipt outside raw evidence, run focused typecheck/check,
   and commit the preview branch for local installation. Do not globally
   install or replace the default public surface.

Do not print provider credentials, raw session paths, raw provider payloads,
private evidence paths, or unredacted Team/Session internals in chat.
