# RC.6 release-boundary handoff

Date: 2026-08-05
Stage: hardening toward sharing
Status: implementation candidate verified by its assigned verifier, but **not release-ready** after lead interface review found a missed clean-cut requirement

## Owner request and fixed mandates

The owner authorized end-to-end delivery and publication of the next Pi Team Bright prerelease. Keep Workers on the agreed plan, escalate real blockers, and otherwise deliver quickly.

Two mandates remain one release boundary:

1. Minimize native `bd` CLI calls and exact hydrated Task-ID scope without changing model-facing semantics. Preserve exact multi-ID `task_read`, the direct Worker one-read path, and no-version `task_link` outer-read removal. Do not restore the unsafe event cache, update batch-preflight shortcut, create shortcut, or compact lifecycle guards.
2. Make the current Task domain the only domain above the Beads adapter. One `TaskCard` and public `TaskVersionRef` must serve tools, sync, Workers, delivery, TUI, events/outboxes, and lifecycle paths. Delivery carries the mutation post-state equal to `task_read` and adds zero `bd` calls. Normal runtime is canonical-only and fails `upgrade_required` for unmigrated records. A stopped-epoch migration may recognize bounded legacy envelopes, but must rehydrate through the adapter and never infer goal or context from old delivery fields.

Only the Beads adapter layer may know native fields, metadata encoding, raw revisions, old CRUD syntax, `RawBead`, or `TaskFile`. The owner explicitly rejected an indefinite dual schema and the old `Candidate` facade.

## Completed coordination and evidence

The first integration Team and its repair continuations exposed several real failures. All of those Teams are now stopped:

- `canonical-task-integration`: stopped with zero unfinished Tasks.
- `canonical-boundary-repair`: initially could not bootstrap because `CandidateBeadsTaskAdapter` was removed while callers still constructed it. The exact Session was later resumed with the repaired working-tree extension; both Workers stopped, reconciliation found no Tasks, and shutdown reported zero unfinished Tasks.
- `rc6-stable-integration`: ran through a detached rc.5 coordination runtime while editing the shared candidate. Both Workers stopped and shutdown reported zero unfinished Tasks.

The stable integration verifier closed its Task with these results on uncommitted HEAD `27a532d1c9c9696afe3790c081028aae8af77d76`:

- `npm run typecheck` passed.
- Model-contract lane: 9 files, 68 tests.
- Exact prior focused lane: 12 files, 83 tests.
- Durability lane: 11 files, 104 tests.
- Canonical acceptance plus minimization: 2 files, 8 tests.
- Worker stale-race and direct one-read focused tests passed.
- `git diff --check` passed.
- Delivery parity reported `bdCallCount: 0`.
- Exact multi-ID hydration and no-version `task_link` proofs passed.
- No aggregate, version, commit, tag, push, or publication action ran.

One verifier claim hung beyond the Beads timeout. It was cancelled, then reconciled by `task_read`; the Task was already `in_progress`, so verification continued without a second claim.

The detached coordination runtime is `/tmp/ptb-rc5-runtime.WIw6PE`. It was changed only as temporary infrastructure: workspace-root `node_modules` is linked and Worker launches add `-ne` before its explicit extension. The shared candidate tree was not reset or reconstructed. Exit any remaining coordinator process before removing that worktree.

## Lead review found a missed release blocker

Do **not** bump a version or publish yet. The assigned verifier passed behavior but did not enforce the owner’s full ontology/source-ownership clean cut.

Known production violations still present:

- `src/model-tool-contract/beads-task-adapter.ts` exports `CandidateBeadsTaskAdapter` and many `CandidateTask*` types. It also imports raw authority types from `src/utils/task-authority-types.ts`.
- `src/utils/task-authority-types.ts` defines raw old fields (`description`, `acceptanceCriteria`, `design`, `notes`, raw version, provenance) outside the adapter boundary.
- `src/utils/task-authority-service.ts` owns and exports raw authority mutations and old fields outside the adapter boundary.
- `src/utils/tasks.ts` calls itself a semantic facade but re-exports the raw authority service and imports the adapter, while the adapter imports back through `tasks.ts`. This is both the rejected facade and a circular boundary.
- The current model-tool production surface still uses `Candidate*` throughout `catalog.ts`, `pi-registration.ts`, `runtime.ts`, `result-projection.ts`, `tui-projection.ts`, and `durable-model-tool-port.ts`. Rename the current surface as the current domain; do not call it a candidate.
- `extensions/index.ts` still contains large unreachable legacy tool definitions above the direct current registration. These definitions include old `team_name`/cursor/paging forms and old Task fields such as description, acceptance criteria, design, notes, and raw legacy receipts. `registerWorkerTool` suppresses most at runtime, but dead compatibility code still violates the clean cut and must be removed rather than retained behind an inactive branch.
- The Worker prompt still refers to “retained legacy delivery records.” Align it with canonical-only runtime plus explicit stopped-epoch migration.
- `src/utils/task-delivery-migration.ts` still imports the Candidate adapter and a delivery-local projection type. Keep only envelope recognition and adapter-backed rehydration; use the exact imported `TaskCard` rather than a duplicate card type.
- `src/utils/task-migration.ts` may retain old vocabulary only as an explicit migration boundary. It must not define normal runtime meaning.

The earlier forbidden scan was too weak. New acceptance must reject Task-domain `Candidate*` facades in production, reject raw authority types/old Task fields outside the Beads adapter and explicit migration, reject unreachable legacy tool registration code, and catch duplicate Task-card types. Do not blanket-ban ordinary English “release candidate” or unrelated local variables.

## Immediate continuation

1. Start a fresh current-extension Team. Use one implementation Worker and one independent read-only verifier. Each Task goal must stay below 1,000 characters.
2. Assign a coherent ontology cleanup, not a symptom patch:
   - make current model-tool names current rather than Candidate;
   - make a clearly bounded Beads adapter module/folder own raw records, metadata, old CRUD, and mutations;
   - keep `tasks.ts` semantic-only or remove it;
   - delete unreachable old extension tool implementations and the legacy Worker bridge;
   - keep explicit migrations separate and stopped-epoch-only;
   - preserve the accepted call-minimization behavior.
3. Add literal source-ownership acceptance tests before accepting the repair. The verifier must inspect both interfaces and behavior.
4. Use focused checks only. Do not run the aggregate lane during repair.
5. Reconcile current docs. `docs/reference.md` currently says `tasks.ts` owns mutation authority, which conflicts with the owner’s adapter boundary. Decide architecture impact against the canonical Structurizr source; if a depicted responsibility changed, update current context and DSL together.
6. After the repair and independent focused verification pass, stop Workers and shut down that Team.

## Release sequence after the clean cut passes

Target version is expected to be `0.17.0-rc.6` unless repository evidence requires another version.

Release preparation must update at least:

- `package.json` and `package-lock.json`;
- `src/model-tool-contract/model-tool-constants.ts`;
- README install/version/image references;
- `docs/current/README.md`;
- `docs/release/model-tool-parity-checklist.md`;
- generated model-contract HTML through `npm run docs:model-tools`;
- a durable rc.6 release receipt.

Then use a fresh Team for release preparation and one independent aggregate verifier. Run the broad package/release lane once on the exact stable tree. Stop that Team before commit/tag/publication.

Public release requirements:

- public identity `deephbz` with GitHub noreply email;
- `privacy.public=true`; current baseline is `800c143...`;
- normal privacy hooks, no bypass;
- run `git-privacy-scan --ref HEAD history` before publication without printing detected values;
- use normal Git commit/push;
- publish through GitHub Actions npm OIDC under dist-tag `next`;
- run a dry run on the exact source, then tag `v0.17.0-rc.6` and dispatch tagged publish;
- verify registry tarball bytes, integrity, provenance, npm `next`, Git tag, GitHub prerelease, and exact source commit.

The current public version is `0.17.0-rc.5`; npm `next` points to rc.5 and `latest` remains rc.1. No rc.6 release action has run.
