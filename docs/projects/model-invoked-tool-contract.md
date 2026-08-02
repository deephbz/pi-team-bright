---
document_id: pi-team-bright-model-invoked-tool-contract
document_kind: evergreen-shaping-contract
lifecycle_stage: shaping
scope: Model-facing Pi Team Bright coordination tools under the current one-leader and multiple-Worker topology.
responsibility: Own current use cases, candidate call and result shapes, information semantics, and acceptance tests until the executable interface is accepted.
authority: Shaping intent only; registered TypeBox schemas, implementations, and tests own current shipped behavior.
excludes: Generic Team ontology, backend performance decisions, concrete Task-engine selection, and dated evidence.
maintenance: Replace superseded shaping content; move exact accepted contracts to code and historical observations to the journal.
---

# Model-invoked tool contract Project

Updated: 2026-08-02

Stage: **hardening / release candidate**

Status: active. The accepted `team_create` → `ensure_worker` →
`task_create` → snapshot → updates journey now runs as a branch-local durable
preview through the real main extension. Leaders now register the complete
ten-tool candidate surface; the four parity tools are `worker_stop`,
`team_shutdown`, `task_link`, and `alert_send`. Preview-launched Workers keep the current Worker Task surface
over the same Team and Beads authorities. The adapter composes explicit Team
epochs, logical Worker meaning, exact lead-Session resolution, the existing
Worker launch bridge, candidate Beads metadata, structured events, and
acknowledged branch-position storage, and authoritative Task projection
rescan. Missing metadata and unstructured update evidence remain typed gaps.
Leader Task updates use expected-version preflight plus durable operation
metadata replay; Beads 1.1 still lacks database-native compare-and-swap against
arbitrary external writers, so the adapter verifies post-write authority. One
real two-Session Luna workflow passed this mixed-surface decision loop. The
batch Task result preserves independent input order, exact
Task-card fields,
assignment, and Worker nonterminal Task indexes. The read slice returns
complete-or-none ordered found/missing outcomes, preserves duplicate input
occurrences, and leaves the preliminary authority revision unchanged. The
update slice now atomically replaces current context and appends leader journal
provenance, replays identical operations, and refuses duplicate, stale-version,
and conflicting-operation requests without mutation. Model results use
minified named JSON. Task-update operation receipts are scoped by Team,
Task, and operation ID; status transitions keep the assigned Worker's
nonterminal index derived from current Task state. Snapshot projection reads
one Task projection for both Task cards and Worker indexes. Snapshot and
updates now use
hidden branch- and Team-epoch-safe observation state, named cancellation, and
provider-input acknowledgement. Model compaction has no Task or observation
state effect. Team mutations are fenced to the implementation version, while
legacy Team records remain readable and fail closed for the new surface. The
release parity matrix is [`docs/release/model-tool-parity-checklist.md`](../release/model-tool-parity-checklist.md).

Architecture impact: **changed** for the accepted persistence milestone. Pi
Team Bright now owns explicit Team-epoch and logical Worker coordinates plus a
private exact-Session branch-position projection. This catalog remains a
candidate artifact. Direct main-extension preview selection adds no further
component, persistence, authority, or deployment boundary.

## Outcome

Give one long-lived leader a small model surface for a long-lived Team. The
leader creates relatively short-lived Workers for deep semantic areas, assigns
work through Tasks, and supervises the Team through current and incremental
views.

`team_create` bootstraps the journey from an unbound leader Session. The two
ongoing coordination calls are complementary:

- `ensure_worker` establishes or restores capacity for one cohesive semantic
  area; and
- `team_sync` restores current Team context or returns changes for routine
  supervision.

The model does not manage Team locators, cursors, wait times, paging tokens, or
event filters. Exact Session binding resolves the leader's zero or one active
Team. Typed unavailable results cover missing or inaccessible authority.

This Project closes when real leader workflows show fast warm-up, low-noise
supervision, useful Worker boundaries, and fewer invalid calls. Accepted exact
contracts then move to registered schemas, implementations, and tests.

## Source allocation

This file owns shaping intent, rationale, constraints, open choices, and
reversal conditions. Replace superseded content instead of appending it.

The executable candidate source is
[`src/model-tool-contract/catalog.ts`](../../src/model-tool-contract/catalog.ts).
Its initial model-result boundary is
[`src/model-tool-contract/result-projection.ts`](../../src/model-tool-contract/result-projection.ts).
The durable candidate Task projection is
[`src/model-tool-contract/beads-task-adapter.ts`](../../src/model-tool-contract/beads-task-adapter.ts);
it remains internal and unregistered. The preliminary runtime and foreign adapter are
[`runtime.ts`](../../src/model-tool-contract/runtime.ts) and
[`pi-registration.ts`](../../src/model-tool-contract/pi-registration.ts). The
[generated scenario review](../generated/model-tool-contract-review.html) is a
human projection of the catalog. None is current shipped authority.

The accepted initial journey is recorded in
[decision 0009](../decisions/0009-initial-model-tool-journey.md).

Current historical evidence:

- [first in-process vertical-slice result](../journal/2026-08-02-model-tool-first-vertical-slice.md);
- [real-session tool-call audit](../journal/artifacts/2026-08-02-pi-team-toolcall-audit/README.md);
- [design dogfood observation](../journal/2026-08-02-tool-contract-design-dogfood.md);
- [Task-adapter conformance gap](../journal/2026-08-02-task-adapter-conformance-gap.md); and
- [generic Team orchestration model](../../../../docs/current/hc-team-orchestration.md).

Current shipped behavior remains authoritative in
[`extensions/index.ts`](../../extensions/index.ts) and the modules routed by
[`docs/reference.md`](../reference.md).

## Starting ontology and lifecycle

The implementation-independent starting topology is one leader and multiple
Workers. The Team and leader are long-lived. Each Worker lives for a shorter,
semantically deep area with:

- high internal cohesion;
- low prerequisite-context overlap with other Workers; and
- few cross-Worker dependencies.

A Worker is not one Task. Reuse it while its semantic area remains active, then
stop it after that area and its nonterminal Tasks are complete. Worker identity
also remains distinct from its more replaceable Session, process, and terminal
carrier.

Tasks are the only executable work authority. Alerts are exceptional
coordination. Runtime activity, delivery, and terminal state do not prove Task
progress.

The candidate preserves the conceptual capabilities needed for a complete
surface: Team creation, Alerts, Task notification and mutation, Worker ensure,
Worker stop, and Team shutdown. This round designs from first principles and
does not preserve old parameter shapes.

## Current context and journal evidence

Team coordination has two complementary information axes:

```text
Team snapshot = current Team + current Workers + current Task cards
Team updates  = new Team/Worker changes + new Task journal entries
                + latest changed Task state + Alerts

Task current  = title + goal + workflow state + assignee
                + concise current context + version
Task journal  = append-only progress, decision, blocker, result, and note evidence
```

Current context is corrected and replaceable. Journal evidence preserves what
actors reported. Updates avoid repeated context cost. A snapshot restores
orientation after startup, compaction, or suspected context loss.

## Candidate `team_create`

### Call intent

```ts
type TeamCreateCall = {
  name: TeamName;
  purpose: string;
};
```

An unbound leader creates one long-lived Team. The exact calling Session becomes
the leader binding used by later leader-only calls. `purpose` states the durable
coordination outcome and boundary, not one Task.

The call has no carrier placement, Task-backend, terminal, or model settings.
Those choices remain internal and can change without changing the public
contract.

The result reports a created active Team, a refusal because the Session already
has an active Team or the name is unavailable, or unavailable Team/binding
authority. Refusal and unavailable outcomes change no state.

## Candidate `ensure_worker`

### Call intent

```ts
type EnsureWorkerCall = {
  name: WorkerName;
  scope: string;
};
```

The leader chooses a stable name and one deep semantic area. The exact active
Team comes from the leader Session binding. The call does not accept
`team_name`, assign a Task, or claim Worker readiness.

### Result intent

The result reports one of three semantic outcomes:

- created, reused, or reconnected Worker;
- refusal because the name already has a materially different scope; or
- unavailable Team or carrier authority.

The same name cannot silently acquire a new meaning. A separate explicit
operation can change scope if a demonstrated workflow needs it.

## Candidate `team_sync`

### Call intent

```ts
type TeamSyncCall = {
  view: "snapshot" | "updates";
};
```

The exact leader Session binding resolves the active Team. The call has no
`team_name`, cursor, continuation, limit, Task selector, Worker selector, event
selector, or wait duration.

### Snapshot view

Call `team_sync({view:"snapshot"})` after startup, compaction, deliberate
reorientation, or suspected context loss. The result contains the current Team,
Workers, and nonterminal Task cards.

A Task card contains only the coordinates needed for the leader's next choice:

```ts
type TaskCard = {
  id: TaskId;
  title: string;
  goal: string;
  status: TaskStatus;
  assignee?: WorkerName;
  current_context: string;
  version: TaskVersion;
};
```

`goal` combines the desired outcome, relevant boundary, and success signal.
Separate `scope` and `success_criteria` fields add surface without a required
machine distinction, so they are not in the candidate.

`current_context` contains only still-relevant progress, decisions, blockers,
and next actions. Each update replaces it. Superseded detail stays in the Task
journal.

A completed snapshot establishes the hidden incremental baseline at its
observed Team head. It supersedes unseen older updates because the current
projection contains what still matters. Model-context compaction does not reset,
advance, or otherwise participate in this position. A leader requests a
snapshot when its visible context is insufficient.

### Updates view

Call `team_sync({view:"updates"})` for routine supervision. If unseen changes
exist, return them. If the leader is caught up, wait for the next Team change.
Owner input can cancel a wait without returning a Team observation or advancing
the hidden position.

Group changes by Task. Each Task delta contains all new journal entries and one
latest current state:

```ts
type TaskDelta = {
  task_id: TaskId;
  change_kinds: TaskChangeKind[];
  journal_entries: TaskJournalEntry[];
  current: {
    status: TaskStatus;
    assignee?: WorkerName;
    current_context: string;
    version: TaskVersion;
  };
};
```

There are no journal-summary caps, omitted-entry counts, continuations, or
paging semantics. A snapshot plus a batch Task read is the explicit recovery
path if hidden observation state and model-visible context ever diverge.

## Hidden observation position

The observation position is machine evidence, not a model decision. Each
completed observation must bind to the exact Pi Session and active branch,
Team epoch, tool call, Team event range, authority revisions, and freshness.

The next updates call derives its baseline only from matching completed results
on the active branch. Do not commit a separate position before Pi persists the
model-visible result. A crash can replay but cannot skip an update. Same-Session
calls serialize and advance monotonically. A fork creates a new Agent and does
not inherit the source Session's position or Team binding.

Team and Task stores can remain separate authorities. A snapshot is a bounded
current projection with per-authority revisions, not one global linearizable
transaction. If a required authority cannot supply a coherent result, return
`unavailable`, publish no observation, and advance no baseline.

Events wake the reader but do not own Task truth. A durable outbox, controller
rescan, or an equivalent mechanism must prevent a lost wake event from hiding
an authoritative change forever.

## No domain count caps or paging

The candidate places no arbitrary count limit on Workers, nonterminal Tasks, or
journal entries. It also exposes no paging mechanism. The only accepted
starting field budgets are 80 characters for Task title, 160 for goal, and 640
for current context.

Scale remains a performance and evaluation question. Measure serialized size,
latency, decision quality, and failure behavior at realistic Team sizes. Do not
convert benchmark workload points into public domain limits without evidence
that a semantic limit is necessary.

## Raw semantics and deferred model projection

Semantic results use named JSON and JSON Schema. The initial model-facing
`content` is the same validated object serialized without formatting. Models
can read each field without a separate decoding map.

An identity projection function marks the internal implementation seam. It
intentionally returns the semantic result unchanged. Projection is an internal
implementation detail and cannot change tool semantics, extension features, or
domain behavior.

Alternative encodings are deferred design experiments. They are outside the
initial end-to-end delivery and have no configuration or provider contract yet.
Any future proposal must measure total prompt cost and decision quality, not
only result-body bytes.

## Task operations forced by this shape

Future Task create, read, and update calls must accept batches. This avoids one
model call per Task during planning, recovery, and supervision. A multi-Task
request does not imply one cross-Task transaction. Each Task mutation can keep
its own version check, outcome, and receipt.

Mutation receipts must contain enough post-state to avoid an immediate read.
A Task read defaults to current definition and state. Journal history is a
deliberate drill-down. Snapshot plus batch read supplies recovery without
turning `team_sync` into full historical replay.

A meaningful single-Task progress operation must atomically replace current
context, append identified journal entries, apply an optional workflow change,
and commit one new version. An operation ID enables receipt replay without
duplicate evidence. A failed version precondition changes nothing.

The current Beads adapter does not yet prove this contract. Expected-version
checks are preflight reads rather than compare-and-swap, notes are mutable,
idempotent receipt replay is absent, and parent-cycle validation is not
complete. Exposure remains gated on a backend-neutral conformance suite.

## Task and Communication adapters

A Task-engine adapter must provide durable Task identity, atomic single-Task
version checks and progress commits, identified journal evidence, typed graph
validation, current and change queries, and durable change publication.

Communication remains a separate authority. Task changes and typed Alerts can
share delivery mechanics without sharing meaning. Alert acceptance, delivery
attempt, Session observation, and semantic action remain separate evidence.

Beads/Dolt and Pi custom messages are current adapter choices. They do not
define the semantic surface.

## Short skill boundary

Keep a short shipped skill after cutover. It contains tactical guidance only:

- one leader coordinates Workers with bounded, deep semantic areas;
- choose scopes that reduce prerequisite overlap and dependencies;
- Tasks are work authority;
- snapshots restore context;
- updates drive routine supervision; and
- Alerts are exceptional.

The skill must not copy exact parameters, result variants, state machines, or
provider schemas. Do not update the current skill before cutover because it
must still describe the shipped cursor-based surface.

## Schema and review source

Use one TypeBox catalog to derive provider JSON Schema, runtime validation,
contract tests, examples, and static review HTML. Do not add OpenAPI or OpenRPC
without a transport that requires it.

Correct-by-construction rules:

- start with the leader situation, then decision, operation, and schema;
- expose one coherent form per intent;
- use required fields and string enums where providers preserve them;
- split operations if provider projection erases a behavioral distinction;
- keep authorization and exact Session binding in runtime enforcement;
- return a complete semantic projection or no observation; and
- never replay historical prose by default.

## Verification

The candidate evaluator covers:

1. Team creation and exact leader binding from an unbound Session;
2. refusal without state change when an active Team already exists;
3. Worker creation for a deep area with low prerequisite overlap;
4. Worker reuse, reconnection, scope conflict, and unavailable outcomes;
5. explicit warm-up snapshot after compaction;
6. immediate grouped updates without snapshot replay;
7. waiting and cancellation when caught up;
8. full new journal entries with latest Task state shown once;
9. snapshot reset of the hidden baseline;
10. interruption, crash, exact-Session resume, branch, and fork behavior;
11. Task-authority failure with no baseline advance;
12. lost or delayed wake events followed by authoritative rescan;
13. identity projection and named-JSON round trips for every result variant;
14. provider schemas that reject forbidden fields, including `team_name`; and
15. batch Task CRUD with independent per-Task outcomes.

Measure model-facing bytes and tokens, invalid calls, extra turns, warm-up
quality, time to leader decision, missed or duplicate changes, current-context
staleness, and scale behavior.

## Current frontier

1. Run focused release checks, then let the independent release verifier run
   the complete release lane against the exact candidate working tree.
2. Keep the Team implementation-version fence and authoritative Task rescan as
   release requirements for mixed writers and lost event publication.
3. Publish only after the clean package install and external verification pass.

Reversal condition: expose a cursor, filter, paging control, or entity count
limit only when a real leader workflow cannot be served safely without it.
