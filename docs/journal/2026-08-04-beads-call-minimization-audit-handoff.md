# Beads call-minimization audit handoff

Task: `beads-call-minimization-nc3` — Audit Beads calls behind model tools.

This is a read-only audit. No production code was changed by this session.
The Task authority refused `task_read` and `alert_send`: this process belongs to
implementation `0.17.0-rc.5`, while Team `beads-call-minimization` belongs to
`0.17.0-rc.4`. Therefore this session could not claim, update, or close the
Task. Reconcile the Team epoch before the next Task mutation.

## Audit boundary

The leader surface is the ten tools registered by
`src/model-tool-contract/pi-registration.ts`: `team_create`, `team_sync`,
`ensure_worker`, `task_create`, `task_read`, `task_update`, `worker_stop`,
`team_shutdown`, `task_link`, and `alert_send`. The Worker projection exposes
only `task_read`, `task_update`, and `alert_send` through the `workerToolNames`
filter in `extensions/index.ts`. Legacy definitions such as `task_list`,
`check_teammate`, and predefined-team tools are stored but are not current
model-facing tools.

## Baseline native-call matrix

Counts below are normal successful paths, per input item where noted, with no
lock retries and excluding unrelated background delivery scans.

- `team_create`: existing or configured authority: `bd where` + `bd list` = 2.
  A new default Team workspace adds conditional `bd init` = 3. The list scans
  all Team-scoped Tasks but does not detailed-hydrate Task IDs.
- `ensure_worker`: direct durable path uses 0 Beads calls. A newly launched or
  recovered Worker can asynchronously run startup delivery reconciliation,
  which normally adds one `bd list` and can add one `bd show` per prepared owner
  transition. Reuse has no startup reconciliation.
- Leader `task_create`: a new item uses `bd list` (idempotency), `bd create`,
  `bd show` (canonical post-create Task), then a second single-ID `bd show`
  (candidate metadata verification): 4. An idempotency replay or conflict uses
  `bd list` + one `bd show`: 2. Batch items run sequentially in input order;
  missing Worker refusals use 0.
- Leader `task_read`: current code reads each requested occurrence with one
  single-ID `bd show --include-dependents`; N occurrences mean N calls. Duplicate
  IDs are reread. Missing IDs still consume their one attempted show.
- Leader `task_update`: an accepted item uses candidate preflight show, locked
  store precondition show, native `bd update`, and fresh post-write show: 4.
  Operation replay, stale-version refusal, or metadata gap normally uses one
  preflight show. A race during the locked write can add a final recovery show.
  Items run sequentially and duplicate Task IDs are rejected before Beads.
- Leader `team_sync` snapshot: one Team-scoped `bd list` plus one multi-ID
  `bd show --include-dependents` for every non-deleted listed candidate: 2, or
  only list when there are no Task IDs. Immediate `updates` uses the same 2.
  A caught-up updates wait uses 2 before waiting and 2 after the wait = 4;
  cancellation before the second read keeps it at 2. Pending-result replay,
  snapshot-required, unavailable, and contract-gap paths use 0.
- Leader `worker_stop`: the guard calls `bd list`, then one multi-ID show for
  matching assigned nonterminal IDs when any exist; 1 or 2. Terminal stop has
  no Beads call. `team_shutdown` has the same 1-or-2 final scan for all
  nonterminal Team Tasks after stop evidence.
- Leader `task_link`: outer source preflight show, locked source show, target
  show, optional native relation command, and fresh source show: 5 when the
  relation changes and 4 for a no-op. Stale/refused branches consume fewer
  calls. Native mutation is `bd dep add/remove`, `bd dep relate/unrelate`, or
  `bd update --parent`.
- Leader `alert_send`: 0 Beads calls, including when a Task reference is
  attached; Alerts intentionally do not validate or mutate Task authority.
- Worker `task_read`: a found Task uses two single-ID shows: the legacy human
  receipt first, then `projectWorkerReceipt` rehydrates candidate metadata.
  Missing uses one.
- Worker `task_update`: accepted path uses one candidate preflight show, the
  store's locked show, native update, fresh post-write show, and the Worker
  projection rehydration show: 5. A preflight refusal is 1; conflict and
  evidence-guard paths add recovery/projection reads.
- Worker `alert_send`: 0 Beads calls.

The command wrapper and exact flags are in `src/utils/beads.ts` around
`command`, `showManyRaw`, `listRaw`, `createWithResult`, `updateWithResult`,
and `mutateLinkWithResult`. `src/utils/trace.ts` records command names and
counts, but nested semantic traces are not currently parent-correlated.

## Constraints and ranked reductions

Strongest code-level reduction: remove the Worker `task_read` two-stage
hydration by deriving the legacy receipt and candidate projection from one
candidate authority record. Preserve missing and candidate-metadata-gap
semantics with a focused test.

Another safe narrow reduction: when leader `task_link` omits
`expected_version`, skip the unused outer `tasks.readTask`; the locked
`mutateLinkWithResult` source read still protects the mutation. Keep the
preflight for supplied opaque version refs unless the lower seam is redesigned.

Do not remove the Team-sync post-wait hydration. It detects external Beads
writes that have no Team event and preserves complete-or-no-observation and
hidden-watermark semantics. Do not replace the snapshot list plus detailed
multi-ID show with `bd export`; the recorded investigation
`docs/journal/2026-08-04-beads-read-path-investigation.md` proves export is not
semantically equivalent.

Experiments, not immediate fixes: batch leader `task_read` while preserving
per-occurrence missing and freshness behavior; merge update preflight and
locked CAS without weakening external-writer safety; use a supported exact-ID
batch read for task links; and remove the create post-read only if the backend
can preserve operation-identity race detection. Native multi-ID show is a
single CLI call but still loops per ID internally.

## Concurrent tree change to re-audit

While this audit ran, another worker changed the working tree. Known uncommitted
files are `src/model-tool-contract/beads-task-adapter.test.ts`,
`beads-task-adapter.ts`, `durable-model-tool-port.ts`, `executors.ts`,
`in-memory-team-port.ts`, `src/utils/beads.ts`, and `src/utils/tasks.ts`.
The visible delta adds missing-aware multi-ID hydration, leader Task-read
batching, a post-create candidate record, lifecycle list-only guards, and a
durable Task-projection cache with event-directed hydration. It was not
authored by this session and must not be reverted.

## Current-delta re-audit

The current candidate counts are: a new leader `task_create` is `bd list` +
`bd create` + one canonical post-create `bd show` = 3 because the adapter
reuses that exact candidate record; replay/conflict remains `bd list` + one
candidate `bd show` = 2. This is a conditional reduction, not a definite one:
the old second read also checked operation-identity semantics after the create
lock released, so reuse can miss an immediate external change between the
post-create show and adapter validation.

Leader `task_read` now deduplicates IDs and uses one multi-ID candidate `show`,
then restores ordered duplicate occurrences. Mixed missing IDs map to
positional `undefined` through the new missing-aware Beads seam. This is a
strong candidate, but the unavailable-result conversion and exact duplicate
freshness need contract tests; native multi-ID `show` still performs its own
per-ID work internally.

Leader `task_update` now attempts one batch candidate `show`, then uses the
preflight record for each adapter decision. An all-found accepted batch is
nominally 1 + 3N calls (`show` once, then locked `show`, `bd update`, and fresh
`show` per item), versus 4N. The reduction is not safe as written: operation
replay and candidate metadata checks use a preflight captured before earlier
items and external writers, so an intervening same-operation write can become
a version conflict instead of a replay. A focused race/replay seam is required
before accepting this reduction.

Event-directed `team_sync` can use zero Beads calls for a worker-only event or
one multi-ID `show` for named Task events; full snapshot and quiet no-event
paths remain list + show, with a post-wait rescan. The cache is not complete
under the documented external-writer model: a silent Task change to B is
hidden when an event for A makes the nonempty-event branch hydrate only A.
An event for a deleted or no-longer-listed Task can also throw or add a Task
that the list projection would exclude. Keep this as an experiment until
mixed event/silent-writer, deletion, and cache-restart tests prove the full
observation contract.

Leader `worker_stop` and `team_shutdown` now use one compact `bd list` instead
of list + detailed show. The receipt only needs IDs, but list-only selection
can race an external assignment before membership deactivation. Treat it as a
safety-contract experiment unless the lifecycle boundary adds an atomic Task
fence.

The Worker `task_read` bridge now performs one candidate `show` for a found
Task and reuses that raw candidate record in the legacy receipt projector;
missing remains one attempted show. This is the strongest definite reduction,
subject to the focused receipt identity test. Worker `task_update` still has
its candidate preflight, locked read, update, fresh read, and final projection
read on accepted paths.

`npm run typecheck` passed on the current tree. A first focused Vitest run
started while the other Worker was editing tests and reported four transient
failures; that run is retained as historical evidence only. After the diff
settled, these checks passed: `npx vitest run
src/model-tool-contract/beads-task-adapter.test.ts
src/model-tool-contract/durable-model-tool-port.test.ts
src/model-tool-contract/first-journey.test.ts
src/model-tool-contract/mutation-call-minimization.test.ts` — 4 files, 43
tests; `npx vitest run src/utils/worker-task-update-version-ref.test.ts` — 1
file, 4 tests; `npx vitest run src/utils/task-delivery.test.ts` — 1 file, 10
tests; and `npm run typecheck`. These tests prove the intended seams, not the
unproven race semantics listed above.

Focused tests run before that concurrent delta settled: `npx vitest run
src/model-tool-contract/beads-task-adapter.test.ts
src/model-tool-contract/durable-model-tool-port.test.ts
src/model-tool-contract/first-journey.test.ts` — 3 files, 34 tests passed.
Deliver the compact matrix and ranked candidates as the Task result once the
Team epoch permits Task mutation.

## Exact source and focused-test pointers

- Public registration is `src/model-tool-contract/pi-registration.ts:75-276`;
  the role filter is `extensions/index.ts:574-606,665-676`; exact leader names
  are asserted in `src/model-tool-contract/first-journey.test.ts:78-88`.
- `team_create` calls `DurableModelToolTeamPort.createTeam`
  (`src/model-tool-contract/durable-model-tool-port.ts:200-259`), which reaches
  `resolveTeamTaskAuthority` (`src/utils/tasks.ts:54-85`); authority calls are
  `BeadsTaskStore.assertWorkspaceRoot`/`list` (`src/utils/beads.ts:554-668`).
- `ensure_worker` is `durable-model-tool-port.ts:261-298`; its direct path has
  no Beads call. Startup delivery reconciliation is
  `src/utils/task-delivery.ts:515-625`.
- Leader `task_create`, `task_read`, and `task_update` are
  `durable-model-tool-port.ts:311-408` and the candidate adapter is
  `src/model-tool-contract/beads-task-adapter.ts:330-490`. Native create/show
  and candidate batch hydration are `src/utils/beads.ts:690-805`.
  Focused tests are `beads-task-adapter.test.ts:90-450`,
  `durable-model-tool-port.test.ts:260-340`,
  `mutation-call-minimization.test.ts:50-100`, and the semantic batch/replay
  cases in `first-journey.test.ts:220-660`.
- Leader `task_link` is `durable-model-tool-port.ts:423-460`, with the locked
  graph authority in `src/utils/beads.ts:955-1005`. The no-version reduction
  has a focused test in `mutation-call-minimization.test.ts:100-125`; graph
  semantics are covered in `release-p1-contract.test.ts:667+`.
- Leader `team_sync` is `durable-model-tool-port.ts:490-570,631-735`;
  native list/show are `src/utils/beads.ts:667-668,798-805`. Snapshot and
  watermark tests are `durable-model-tool-port.test.ts:100-258,340-510` and
  the existing multi-ID authority seam is `beads-task-adapter.test.ts:197-350`.
- Leader lifecycle calls delegate from `durable-model-tool-port.ts:409-421`
  to `extensions/index.ts:1340-1405`; the current compact-ID experiment is
  tested in `mutation-call-minimization.test.ts:125-170`. Legacy detailed
  lifecycle paths remain at `extensions/index.ts:2771` and `:3051`.
- Leader `alert_send` is `durable-model-tool-port.ts:462-488` and
  `src/utils/alerts.ts`; it has no Beads authority path. Worker projection
  and the one-read `task_read` handoff are `extensions/index.ts:359-523,2862-2930`;
  the real-Beads focused test is `src/utils/worker-task-update-version-ref.test.ts:249-290`.
- Native command shapes are `src/utils/beads.ts:583-594,625-668,690-734,
  845-1005`; command counts are recorded by `src/utils/trace.ts:5-75`.

## Exact epoch handoff

Files changed by this Worker: only this journal handoff,
`docs/journal/2026-08-04-beads-call-minimization-audit-handoff.md`. No
production file was edited by this Worker. The shared checkout also contains
uncommitted work from other Workers in `extensions/index.ts`,
`src/model-tool-contract/beads-task-adapter.ts`,
`src/model-tool-contract/beads-task-adapter.test.ts`,
`src/model-tool-contract/durable-model-tool-port.ts`,
`src/model-tool-contract/durable-model-tool-port.test.ts`,
`src/model-tool-contract/executors.ts`,
`src/model-tool-contract/in-memory-team-port.ts`,
`src/utils/beads.ts`, `src/utils/task-delivery.ts`,
`src/utils/task-delivery.test.ts`, `src/utils/tasks.ts`,
`src/utils/worker-task-update-version-ref.test.ts`, and the new focused
`src/model-tool-contract/mutation-call-minimization.test.ts`. Do not reset or
overwrite those files.

Verification evidence: `npm run typecheck` passed;
`beads-task-adapter.test.ts`, `durable-model-tool-port.test.ts`,
`first-journey.test.ts`, and `mutation-call-minimization.test.ts` passed with
43 tests; `worker-task-update-version-ref.test.ts` passed with 4 tests;
`task-delivery.test.ts` passed with 10 tests; and `git diff --check` passed.

Open risks are the stale operation-replay decision in batched update
preflight, incomplete event-directed sync under silent external writers or
deleted Tasks, list-only lifecycle races, and create post-read operation
identity races. These are not accepted reductions.

Next action: the lead must verify this artifact, reconcile the mixed rc.4/rc.5
Team epoch, and resolve the assigned Task from a single-version Team. After
this handoff, this Worker must stop editing.
