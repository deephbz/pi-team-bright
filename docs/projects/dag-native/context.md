# Pi Team Bright DAG-native prototype context

Updated: 2026-08-12
Stage: hardening on the published RC13 semantic base
Status: separate local `feature/dag-native-rc13` branch is rebased on RC14 publication tip `origin/main` `325fe3b69fe6127808b1fdb0dcf3e3d707635a1a`, whose release code is tagged at `8bb517bd32d8687e97b96a531db15833fd64420a`; focused DAG/liveness integration, full aggregate, package, agent-surface, lane, diff, and privacy-range checks pass; final work remains local and no push or tag is authorized

## RC14 liveness-hotfix rebase

The three squashed DAG commits now apply directly after the RC14 publication
record on `origin/main`; the release code remains annotated tag
`v0.17.0-rc.14`. The rebase preserves RC14's lock-free runtime reads, filtered
and coalesced liveness scans, single-flight Task projection reads, and exact
Membership recovery fence. DAG ready-front reconciliation remains Task-authority
work and does not replace those Coordination and Worker-recovery controls.

Focused post-rebase checks cover the RC14 liveness and recovery paths together
with DAG validation, mechanical dispatch, real Beads delivery, reconciliation,
model-tool journeys, clean-cut E2E, and provider-schema budgets. The final
aggregate passed 136 file runs and 922 tests, with 56 intentionally skipped
causal variants. Package, generated output, agent-surface, lane, diff, and
privacy-range gates also passed. This is now the accepted local DAG verification
baseline; a new live multi-Session stress remains separate runtime evidence.

## Model-tool token budget

The isolated [DAG audit](model-tool-token-budget.md) found that nested existing/new
Task reference unions made `task_create` cost 505 estimated compact `o200k_base`
tokens. The accepted [cross-surface budget](../model-tool-context-budget.md) embeds
request-local `needs` keys, flattens Alert targets, and removes repeated schema
prose. The complete nine-tool definition fell from 1,716 to 1,191 estimated
tokens. Existing-Task graph expansion stays outside the frequent model verb
because no canary or stress trace required it.

## Contention-rebase diagnosis and repair

The DAG branch now starts at documentation tip
`d2dfc7004d73f7a69c2a8cf23bd4c691162fe51a`, including contention-hardening
source `8c74a5c9e2b5c1c645fcfc89c107a438a4272fbc`. Live DAG stress showed two
remaining DAG-owned failures. Ready reconciliation still read the complete Task
set through 13/16-ID canonical shows, and a failed successor delivery had no
periodic Task-authority retry. Two stress drivers also omitted assignees, which
created valid historical unassigned records but invalid executable work.

Current source makes ready reconciliation narrow and self-healing. Beads selects
blocker-aware ready Tasks plus in-progress Worker occupancy, then exactly hydrates
at most one candidate per free Worker. Each Worker delivery loop periodically
retries that Worker's ready frontier. Conservative canonical-show fallback uses
four-ID batches, below the observed live contention tail. Provider schema and
domain validation require one current Worker assignee for every created Task.

Exact source `76706c7cda4fe0091d9ac5a3f4db9f9a18849cb1` passed a fresh Pi 0.83.0
canary. One atomic `plan -> impl -> review -> verify` chain crossed `maker` and
`reviewer` without leader Task updates. All four Tasks closed. Worker-authored
Task events were cursors 9, 10, and 13 through 18; the complete journal had 20
unique contiguous cursors. Both Workers stopped, Team shutdown retained no
unfinished Task, and the worktree stayed clean. External receipts live under
`~/.local/state/pi-team-bright/stress/` with prefix
`canary-dag-76706c7-20260812-a`. This proves the repaired handoff, not
109-Task capacity.

## Finalized-base live canary

Source commit `82e3b417c1ff2ee7d05bacc0fe28a37c4bb3d92b` passed the live
Pi 0.83.0 multi-Session canary with merge base
`dfe1552784abf92d4426f48912594b12e415a755`. The semantic-hardening branch
remained unchanged. The coordinator started through `_codex_with_proxy` with
`openai-codex/gpt-5.6-terra:medium` and confirmed the required proxy names
without printing values.

One atomic operation created `plan -> impl -> review`; `maker` handled the first
two Tasks and `reviewer` handled the third. Durable Worker-authored claim and
result events were cursors 8 through 13. Each successor claim followed its
prerequisite result. The leader made no `task_update` call. Both Workers stopped,
shutdown retained no unfinished Task, and every Membership became inactive. The
[receipt](../../journal/2026-08-11-v0.17.0-rc.12-dfe-side-branch-live-canary-receipt.md)
and [machine artifact](../../journal/artifacts/2026-08-11-v0.17.0-rc.12-dfe-side-branch-live-canary.json)
record the evidence, invalid preceding input attempt, cleanup, and proof limits.

## Historical live canary

Local source commit `e8b42b0cd80fb30ca4f7ba1347cda99c95d0a380` passed a fresh
Pi 0.83.0 multi-Session canary on the earlier semantic-hardening base
`ec7642a2d54c44b0c941048c74f14695c87f5c9d`. This is historical evidence only
because the DAG side branch now starts from finalized base `dfe1552`. The
coordinator started through `_codex_with_proxy` with
`openai-codex/gpt-5.6-terra:medium` and confirmed the required proxy variable
names without printing values.

One atomic operation created `plan -> impl -> review`; `maker` handled the first
two Tasks and `reviewer` handled the third. Worker-authored claim and result
events were cursors 8 through 13. Each successor claim followed its prerequisite
result. The leader made no `task_update` call. Both Workers stopped, Team
shutdown retained no unfinished Task, and all Memberships became inactive. The
coordinator pane and isolated Pi configuration were removed. The durable
[receipt](../../journal/2026-08-10-v0.17.0-rc.12-final-live-canary-receipt.md)
and [machine artifact](../../journal/artifacts/2026-08-10-v0.17.0-rc.12-final-live-canary.json)
contain the evidence and proof limits.

Earlier canaries remain historical incident evidence for duplicate extension
discovery, inherited Herdr identity, Worker Session startup reconciliation, and
bounded Herdr carrier names. Architecture impact: changed inside Task authority
and the trio-facing contract; no new process boundary.

## Owner authorization and outcome

Develop and test a DAG-native Pi Team Bright autonomously while the separate
semantic-hardening/subsystem refactor remains in progress. Assume that refactor
has finished and implement against its intended semantic boundaries. Deliver an
end-to-end prototype that is approximately 90% portable, then port it after the
hardening work finishes. Do not ask the owner for intermediate decisions; use
judgment and choose the simplest effective shape.

The required product outcome is one atomic Task DAG assigned across one or more
stable Workers, followed by mechanical ready-front dispatch and handoff. The
leader model must not spend turns advancing ordinary dependency edges.

## Isolated source bundle

- Worktree: isolated prototype worktree
- Branch: `rc/v0.17.0-rc.12`
- Semantic-hardened base branch: `audit/semantic-hardening-behavior-inventory`
- Final semantic-hardening base: `dfe1552784abf92d4426f48912594b12e415a755`
- Candidate package: `@hypercarrier/pi-team-bright@0.17.0-rc.12`
- The original `prototype/dag-native` branch remains historical port evidence.
- Rc.12 must preserve the semantic-hardening seams and release behavior.

## Accepted shaping direction

### Public Task creation

Keep the existing Task-first ontology. Do not add graph-create/read/expand model
tools or a Workflow authority. Change `task_create` into one atomic graph-aware
operation and remove `task_link` from the normal model surface.

The model-facing request shape is Make-like while mapping directly to Beads:

```ts
task_create({
  operation_id: string,
  tasks: Array<{
    key: string,
    title: string,
    goal: string,
    assignee: WorkerName,
    needs?: string[]
  }>
})
```

One Task is the one-node case. The request has one operation identity and one
atomic outcome. Each `needs` value is a request-local prerequisite Task key.
Existing-Task expansion stays internal because no observed workflow required it
and its public reference unions dominated the model-tool budget.

`TaskCard` must add outgoing dependency relations and a derived dependency
readiness projection. `task_read`, `task_update`, and `team_sync` reuse that
canonical card. Worker claim refusal must report active blocker IDs. Sync must
surface derived readiness changes without making its event cursor authority.

### Beads translation already proved locally

A disposable probe against the owned `@beads/bd@1.1.0` established:

- `bd create --graph` atomically created a three-node chain and returned a
  local-key-to-ID map;
- model `task X needs Y` maps to graph-plan edge
  `from_key/from_id=X`, `to_key/to_id=Y`, `type=blocks`;
- `bd ready` returned only the prerequisite-free first Task;
- a cyclic plan refused and left the Task count unchanged;
- a later graph plan can use an existing dependent `from_id` and a newly
  created prerequisite `to_key` atomically;
- replaying the same native graph plan created a duplicate Task.

Therefore Pi Team Bright must continue to own request operation replay,
canonical Task metadata, Worker validation, commit-before-delivery, recovery,
semantic errors, and audience projections.
Beads graph syntax stays below the adapter.

### Assignment and mechanical scheduling

For the first contract, assignment is many Tasks to fewer Workers:

```text
Task -> exactly one stable Worker
Worker -> zero or more Tasks
```

If one logical work item needs several independent Workers, represent it as
several Tasks and a join Task. Do not give one Task shared mutable ownership.
Each created Task carries its resolved stable Worker `assignee`. Templates may
use role slots before compilation, but the committed model-tool request uses
actual Worker names. Worker creation remains a separate Team-authority action.

Dispatch eligibility is mechanical:

```text
Task.status == open
AND Task.assignee exists
AND all active blocked_by targets are closed
AND this Task version has no pending/observed delivery
AND the assigned Worker has no active execution slot
```

Default to one active execution slot per stable Worker because one Worker has
one durable Session context. Different Workers execute the ready frontier in
parallel. Several eligible Tasks for one Worker remain durably queued. If their
order matters, the caller encodes it with dependencies; otherwise use one
stable authority order.

Causal path:

```text
atomic DAG commit
  -> derive ready frontier
  -> group by assignee
  -> reserve at most one dispatch slot per Worker
  -> persist Task-version delivery intent
  -> resolve exact current Membership/Session
  -> present Task
  -> Worker explicitly claims and executes
  -> close or block with evidence
  -> release slot and dispatch next frontier
```

Keep explicit Worker claim. Delivery proves presentation, not understanding or
semantic responsibility. `team_sync` observes this path but does not drive it.
Use at-least-once delivery with Task-version and Membership-generation identity;
restart reconciles authority and pending delivery. A blocked Task releases the
Worker slot but does not satisfy downstream prerequisites.

Do not use `bd ready --claim` for automatic dispatch. It would change Task state
before the Worker accepts responsibility and would let backend selection policy
define product scheduling.

## Assumed post-refactor subsystem placement

Use the semantic-hardening target as the wishful architecture:

- Task authority owns canonical Task meaning, dependency validation, derived
  readiness, assignment meaning, versions/replay, atomic graph mutation,
  execution-slot policy, Task delivery intent, and recovery.
- Team authority supplies narrow stable-Worker and exact current
  Membership/Session resolvers.
- Pi Session actuation presents Tasks but owns no work truth.
- Coordination observation projects committed Team/Task/Alert changes and
  acknowledged branch position. It never schedules Tasks.
- Trio-facing interface/projection code owns public TypeBox syntax plus raw,
  model, and TUI projections. It contains no Task policy.
- Alert authority and additive Membership observation remain outside the DAG
  change.

Cross-authority behavior must use consumer-owned ports and a composition root.
Do not create direct Team↔Task import cycles or share private authority records.
Task commit and durable delivery intent must survive a crash before coordination
publication.

## Known baseline implementation facts

- `BeadsTaskStore` in `src/utils/beads.ts` has a private CLI command method,
  single-Task `createWithResult`, list/show hydration, best-effort external-writer
  version preflight, claim, and per-edge mutation.
- Current single-Task operation replay searches metadata by idempotency key.
- Native Beads graph replay has no Pi Team Bright request identity.
- Current expected-version protection is explicitly best-effort because Beads
  1.1.0 has no true conditional write and an external writer can race after
  preflight.
- Current specific-Task claim uses `bd update --claim` and does not yet prove
  blocker-aware readiness.
- Current assigned Task creation publishes immediately. DAG creation must defer
  all publication/delivery until the complete graph commit is durable.
- Current `TaskCard` omits relations/readiness.
- Current `task_create` commits batch items independently with one operation ID
  per item; its result permits per-item partial and unknown outcomes.

## Implementation strategy

Build a portable vertical slice around backend-neutral Task-authority contracts
instead of spreading DAG policy through current orchestration files.

1. Add pure DAG request/result, reference, relation, readiness, validation, and
   scheduling types with deterministic unit/property-style cases.
2. Add a Beads graph adapter that compiles the public request to graph-plan JSON,
   applies Team metadata to every node, validates current Worker and existing
   Task references, and projects the complete committed result.
3. Add request-level operation receipt/reconciliation so exact replay returns
   the original key mapping and changed replay refuses. Native duplicate replay
   is not acceptable.
4. Add dependency-aware claim refusal and ready-front calculation.
5. Add one-Worker-slot mechanical dispatch with durable Task-version delivery
   intent and restart reconciliation. Reuse current Task delivery mechanisms
   behind ports where safe; do not let projection state drive dispatch.
6. Replace the model-facing `task_create` schema/result, remove `task_link`, add
   DAG fields to `TaskCard`, and update raw/model/TUI projections.
7. Add focused pure, in-memory, real-Beads, registered-tool, projection-parity,
   crash/replay, and end-to-end tests.
8. Run one real or headless Pi Team flow if the available compatible runtime can
   safely load this worktree. Otherwise leave an exact deterministic E2E runner
   and record the runtime blocker honestly.

Keep the wishful Task-authority types and tests isolated enough for later port.
Do not refactor unrelated Team, Alert, terminal, or projection code merely to
make the baseline look like the future architecture.

## Required end-to-end evidence

At minimum prove:

- atomic four-Task DAG creation across two stable Workers;
- only the first ready Task is initially presented;
- a Task with active prerequisites cannot be claimed;
- closing a Task mechanically presents its successor without a leader model
  turn;
- different Workers receive independent ready Tasks in parallel;
- one Worker with two eligible Tasks receives one while the other stays queued;
- blocking releases the Worker slot but keeps downstream Tasks waiting;
- crash after graph commit recovers the same key mapping and pending delivery;
- exact create replay does not duplicate Tasks;
- changed replay refuses;
- model, raw machine, collapsed TUI, and expanded TUI projections agree;
- existing non-DAG Team/Worker/Alert/observation behavior remains green except
  for explicitly replaced model-tool contract expectations.

## Test discipline

Use focused tests during iteration. Do not run aggregate lanes repeatedly.
After implementation and all focused checks stabilize, run typecheck, the
proportional package tests, one real-Beads E2E, package verification, and one
aggregate lane against the exact final tree. Preserve raw E2E receipts under a
dated journal artifact. A trace is not correctness; anchor the main claim to
independent Beads reads and exact Session/Task records.

## RC13 integration continuation

The local `feature/dag-native-rc13` branch reconstructs the DAG-native work on
the published semantic-hardening `origin/main` at
`53367e412ad0217bfcf4845d92a07bb9ebec6de2`. The published branch and RC13 tag
remain unchanged. A backup ref preserves the pre-rewrite DAG tip `9ccd0a7`.
The owner did not authorize a push, tag, or publication, so the integrated work
and rewritten history remain local.

Rebase conflicts are resolved. The resolution keeps the split Team, Task,
Alert, and Coordination applications. It preserves the exact Worker actor fence,
Task-authority ports, Worker schema without `team_name`, and the hardened
`caught_up` and `indeterminate` meanings. Typecheck and focused integration,
real-Beads, surface, Session-adapter, agent-surface, model-probe, lane, and
42-case tool-result QA checks pass on the rewritten tree.

Boundary adaptation is complete without another public-schema redesign. Rc.11
Task update, journal, reconciliation-query, mutation-publication, failed-hint,
and read-only-default semantics remain. Mechanical selection now lives in
`task-authority/ready-dispatch.ts`. `DurableTaskMutationPublication` implements
the consumer-owned delivery coordinates, and `DurableTaskOrchestration`
composes graph commit, operation-specific publication recovery, and ready
reconciliation. Pi composition injects these ports into leader and Worker paths.
The trio-facing durable port no longer constructs Beads graph storage or reads
Task-delivery records. Package version remains release identity, not a Team
persistence coordinate.

The hardened `caught_up` and `indeterminate` meanings remain unchanged and are
explicit in the DAG contract. Current context and semantic-hardening dependency
evidence describe the injected DAG boundary. The final aggregate, package,
surface, and fresh live-canary gates pass on the exact integrated source.

Use focused tests during adaptation. On the stable tree run typecheck, fast,
exhaustive/full, real Beads graph and delivery E2E, package installation, agent
and tool-result QA, lane closure, public/persistence/privacy checks, and an
exact installed-tarball probe. A full live Pi multi-Session canary is required.
Before that canary, load `pi-teams-proxy`; start the coordinator through
`_codex_with_proxy` with `openai-codex/gpt-5.6-terra:medium`, verify inherited
proxy environment, and use an assigned Task plus a Worker-authored Task event as
the end-to-end launch signal. Do not use `agentLoopReady` or manual exact-
Session fallback. Do not push, tag, publish npm, or change the registry.

## Current result and port frontier

The isolated prototype implements the portable DAG domain, mechanical dispatch
reference, atomic Beads graph adapter, exact graph-operation replay, internal
existing-dependent expansion, derived Task-card readiness, blocker-aware claim,
nine-tool registration, projection parity, and durable ready-front reconciliation.
Reconciliation runs after graph creation, committed Task updates, and Worker
ensure. Assigned native Beads claims now change an already assigned Task to
`in_progress` instead of asking Beads to assign it again.

The stable tree passed 38 focused policy and adapter tests, 35 focused surface
and projection tests, three real-Beads graph tests, and one real-Beads six-Task
delivery E2E. `npm test` passed 57 files and 442 tests. The full lane passed 77
files and 593 tests. Package verification, agent-surface QA, and the test-lane
manifest passed. Result evidence is in
[`../../journal/2026-08-09-dag-native-prototype-result.md`](../../journal/2026-08-09-dag-native-prototype-result.md).

The E2E proves initial ready-only delivery, active-blocker claim refusal,
automatic successor delivery, parallel Workers, one slot per Worker, and
blocked-slot release with a waiting join. It uses real Beads authority and
durable delivery records. It does not claim a real Pi multi-Session canary.

The rc.12 adaptation now moves mechanical ready selection behind a Task-owned
query and consumer-owned delivery port. The trio-facing durable façade imports
neither Beads graph storage nor concrete Task-delivery records. A durable
orchestration adapter composes graph commit, operation-specific missing-event
recovery, and ready reconciliation. Exact replay repairs a graph-only committed
receipt, then remains silent after publication exists.

On the finalized hardening base, two focused lanes pass 124 and 80 tests. After
one four-case fixture correction, the bounded Node 22.22.1 aggregate passes 125
files and 884 tests in 344.49 seconds. Package verification, tracked generated
output, agent-surface QA, the nine-tool model probe, lane closure, JSON checks,
and the configured-baseline privacy range pass. The fresh live canary passes on
source commit `82e3b417c1ff2ee7d05bacc0fe28a37c4bb3d92b`. Full-history privacy
findings remain inherited from grandfathered pre-baseline history. Earlier
aggregate and canary receipts prove only their prior bases.

## RC13 stress and quality result

The completed exact-source capacity run at pre-rewrite tip `9ccd0a7` used eight
Terra-medium Workers. It atomically created eight 13-Task chains and five
independent recovery Tasks. All 109 workload Tasks and eight preflights closed,
for 117/117 closed Tasks. Every Worker returned exact stop evidence and Team
shutdown retained no unfinished Task IDs. The initial graph create returned
`unknown_outcome`, but an independent Beads export proved exactly 109 workload
records. The run recovered through transient Dolt lock and context-canceled
sync failures without leader Task updates. The external receipts are
`~/.local/state/pi-team-bright/stress/stress-dag-9ccd0a7-20260812-e.json` and
its Markdown peer.

The run did not complete exact large-payload replay, changed-payload conflict,
stale-version refusal, or a contiguous event audit. Focused deterministic tests
cover these semantics, but they are not part of the capacity proof. A post-rebase
live retry could not start Worker carriers because the installed Herdr returned
`agent_name_not_found` after each split. All three disposable Teams shut down
with zero unfinished Tasks, but this is harness incident evidence, not DAG
execution evidence. The earlier successful capacity run remains the live anchor.

Two fixed Million Eyes rounds reviewed committed states. Round one accepted one
bounded recovery-spool improvement: identical unresolved delivery obligations
now coalesce. Round two found that recipient order and serialized Task-card
property order made that identity unstable. The accepted repair compares the
opaque Task/version/change coordinates and a sorted recipient set while keeping
the first canonical projection. Focused delivery and ready-dispatch tests pass.
The reports are outside tracked source under
`~/.local/state/pi-team-bright/reviews/dag-native-rc13/round{1,2}`.

Rejected findings were the removal of internal `task_link` result compatibility,
which is not a registered model tool, and a redundant target-deduplication
cleanup outside the DAG-owned risk. The review-only `task_link` signature is
also harmless and was not changed. There is no evidence for another quality
round.

Keep DAG card fields optional until stopped-epoch migration evidence supports a
contract change. Publication remains unauthorized; do not push, tag, publish
npm, or change the registry.
