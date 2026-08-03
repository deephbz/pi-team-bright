---
document_id: pi-team-bright-model-invoked-tool-contract
document_kind: evergreen-shaping-contract
lifecycle_stage: hardening
scope: Model-facing Pi Team Bright coordination tools under the current one-leader and multiple-Worker topology.
responsibility: Own current use cases, call and result intent, information semantics, and acceptance tests for the shipped executable interface.
authority: Shaping intent only; registered TypeBox schemas, implementations, and tests own current shipped behavior.
excludes: Generic Team ontology, backend performance decisions, concrete Task-engine selection, and dated evidence.
maintenance: Replace superseded shaping content; move exact accepted contracts to code and historical observations to the journal.
---

# Model-invoked tool contract Project

Updated: 2026-08-03

Stage: **hardening**

Status: active. The accepted `team_create` → `ensure_worker` →
`task_create` → snapshot → updates journey runs through the shipped durable
model-tool surface in the real main extension. Leaders register the complete
ten-tool surface; the four parity tools are `worker_stop`, `team_shutdown`,
`task_link`, and `alert_send`. Workers keep the current Worker Task surface
over the same Team and Beads authorities. The adapter composes explicit Team
epochs, logical Worker meaning, exact lead-Session resolution, the existing
Worker launch bridge, model-tool Beads metadata, structured events,
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
and conflicting-operation requests without mutation. Raw semantic results remain
machine truth. The accepted projection boundary derives a small validated model
result, a concise collapsed TUI, a structured expanded TUI, and an exact QA
trace from that truth. The retired pass-through projection and result-envelope
path are not part of the current surface. Task-update
operation receipts are scoped by Team,
Task, and operation ID; status transitions keep the assigned Worker's
nonterminal index derived from current Task state. Snapshot projection reads
one Task projection for both Task cards and Worker indexes. Snapshot and
updates now use
hidden branch- and Team-epoch-safe observation state, named cancellation, and
provider-input acknowledgement. Model compaction has no Task or observation
state effect. Team mutations are fenced to the implementation version, while
legacy Team records remain readable and fail closed for the new surface. The
release parity matrix is [`docs/release/model-tool-parity-checklist.md`](../release/model-tool-parity-checklist.md).

Architecture impact: **changed** for the accepted persistence milestone and
public result-projection contract. Pi Team Bright owns explicit Team-epoch and
logical Worker coordinates plus a private exact-Session branch-position
projection. It also owns model, TUI, and QA projections derived from raw tool
semantics. The canonical diagram records that responsibility. No new component,
persistence, authority, trust, or deployment boundary is proposed.

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

The executable model-tool source is
[`src/model-tool-contract/catalog.ts`](../../src/model-tool-contract/catalog.ts).
Its result-projection boundary is
[`src/model-tool-contract/result-projection.ts`](../../src/model-tool-contract/result-projection.ts).
The result-projection implementation is the owning seam for the accepted
model, TUI, and QA projections below. The durable model-tool port is
[`src/model-tool-contract/durable-model-tool-port.ts`](../../src/model-tool-contract/durable-model-tool-port.ts).
The internal Beads Task projection is
[`src/model-tool-contract/beads-task-adapter.ts`](../../src/model-tool-contract/beads-task-adapter.ts).
The runtime and registration adapters are
[`runtime.ts`](../../src/model-tool-contract/runtime.ts) and
[`pi-registration.ts`](../../src/model-tool-contract/pi-registration.ts). The
[generated scenario review](../generated/model-tool-contract-review.html) is a
human projection of the catalog. The executable modules own shipped behavior.

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

The model-tool surface preserves the conceptual capabilities needed for a complete
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

## Current `team_create`

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

## Current `ensure_worker`

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

## Current `team_sync`

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
machine distinction, so they are not in the current surface.

`current_context` contains only still-relevant progress, decisions, blockers,
and next actions. Each update replaces it. The executable candidate schema in
[`src/utils/beads.ts`](../../src/utils/beads.ts) limits it to 2,000 TypeBox
string-length units. Superseded detail stays in the Task journal.

Native Beads notes remain unbounded raw evidence. A marked Worker `append_note`
that would exceed the candidate context limit refuses without mutation. Worker
candidate receipts use validated canonical metadata, or return a typed metadata
gap; they never copy native notes into `current_context`.

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

The model-tool surface places no arbitrary count limit on Workers, nonterminal Tasks, or
journal entries. It also exposes no paging mechanism. The only accepted
starting field budgets are 80 TypeBox string-length units for Task title, 1,000
for goal, and 2,000 for current context.

Scale remains a performance and evaluation question. Measure serialized size,
latency, decision quality, and failure behavior at realistic Team sizes. Do not
convert benchmark workload points into public domain limits without evidence
that a semantic limit is necessary.

## Accepted result-projection contract

The raw per-tool semantic union in the TypeBox catalog is the sole result
authority. A tool validates that result once, then derives separate projections
for the model, human TUI, and QA trace. A projection can omit or reorganize
facts, but it cannot invent state or change the semantic outcome.

This is a breaking cutover. The retired envelope, pass-through model
projection, generic legacy normalizer, and recursive object renderer are not
part of the current surface. Do not add a compatibility detector. An
unsupported persisted result must fail closed with one explicit
unsupported-result diagnostic. It must never render as accepted. Historical
journals remain historical evidence and are not rewritten.

### Model projection

Each tool has a TypeBox model-result schema derived from its semantic union.
The serialized JSON contains only facts needed for the model's next decision.
The tool call already supplies the operation name, so model content does not
repeat an envelope schema or operation field. Named fields remain preferable
to positional encoding. The catalog records a model-projection version for QA
and source-bundle reproduction. That version is not repeated in each model
result.

Common rules:

- omit input text that the model just supplied when the semantic result did not
  normalize or reject it;
- omit constant `state_changed: false` fields when the result kind already
  guarantees no mutation;
- keep Task IDs and versions because later conditional actions require them;
- keep full Task cards for deliberate reads, snapshots, update deltas, and
  version conflicts;
- keep accepted and failed recipient names, but omit opaque Alert and delivery
  IDs;
- preserve runtime-specific failure messages only when a typed reason and
  recovery action are not sufficient; and
- keep thrown execution or provider errors on Pi's error path. Never convert
  them into semantic refusals.

Per-tool model projections retain these facts:

- `team_create`: created Team name and lifecycle, or refusal/unavailable reason
  and recovery. Omit the echoed purpose.
- `ensure_worker`: Worker name, created/reused/reconnected effect, and carrier.
  A scope conflict keeps the existing Worker's scope.
- `task_create`: its caller-supplied `operation_id`, Task ID, status, assignee,
  and version per input. Omit echoed title and goal after success. An unknown
  outcome retains the same operation coordinate and directs an exact retry.
- `task_read`: complete current Task cards, or explicit missing and contract-gap
  outcomes. A deliberate read is not compressed into a mutation receipt.
- `task_update`: Task ID, status, assignee, and new version after success. A
  conflict keeps the complete current Task and typed retry coordinate.
- `team_sync`: complete snapshot or update data. Non-observation outcomes keep
  reason, unchanged observation state, and recovery only.
- `task_link`: source, relation, target, action, changed state, and version.
- `alert_send`: accepted and failed recipients plus an optional Task reference.
  Omit Alert ID and echoed text.
- `worker_stop`: stopped/refused state and guarding Task IDs.
- `team_shutdown`: lifecycle, stopped and failed Workers, and unfinished Task
  IDs. A partial result states that the Team remains active.

For `task_create`, `task_read`, and `task_update`, a one-item semantic batch
projects as one result. It has no outer `outcomes` array or `input_index`.
Multi-item calls retain an ordered batch and input indexes. The raw semantic
result remains batch-shaped in both cases.

Each `task_create` item has one required opaque `operation_id`. The adapter
scopes it to the active Team and persists it in the same Beads create command.
A retry returns the existing Task only when title, goal, assignee, and initial
canonical candidate semantics still match. Different input with the same
operation ID refuses without mutation. A post-authority error is
`unknown_outcome`; retry exactly that operation ID, never a new create.

A successful Task mutation returns the Task ID, status, assignee, and new
version. It does not echo submitted context, journal text, or generated journal
provenance. A version or operation conflict returns the complete current Task
and a typed `reconcile_and_retry` recovery coordinate containing the exact
current version. It never copies the full prior mutation into retry arguments.

A `team_sync` snapshot and update result retains the complete bounded
orientation or delta. `contract_gap`, `unavailable`, `cancelled`, and
`snapshot_required` results state that observation did not advance. They return
no entity counts. `structured_task_event_evidence_absent` supplies a typed
`request_snapshot` recovery action. The missing event evidence remains in the
raw semantic result and QA trace.

### Human TUI projection

Collapsed output has one semantic outcome line plus only the facts needed to
understand the effect or next action. Batch output starts with a count and then
names failures, conflicts, or guarded resources. It never prints `unknown` or a
zero count when the semantic result does not contain a collection.

Expanded successful output uses allowlisted per-tool cards and lists. It shows
semantic details once. It does not show model JSON, recursive raw objects,
legacy warnings, private paths, Session or Membership IDs, or opaque backend
identifiers. Recovery guidance appears as `Next:` only when action is required.

Thrown execution errors and malformed result details bypass the successful
semantic renderer. Their TUI output names the tool and shows the unmodified
`content` and `details` in one copyable JSON report. It tells the operator to
review sensitive fields before sharing. It never replaces the source error with
a generic “no semantic result” message.

Human tone derives from the semantic discriminant. `refused`, `unavailable`,
`contract_gap`, `cancelled`, `snapshot_required`, and `partial` remain distinct.
A thrown execution error remains distinct from all semantic outcomes.

### Trace and QA projection

The projection QA bundle contains the exact raw semantic result, exact model
projection, serialized model content, and collapsed and expanded TUI lines. Its
bundle metadata records the catalog version, source revision, and projection
version. Synthetic QA fixtures can retain complete payloads.

The existing `PI_TEAMS_TRACE_JSONL` operational trace remains payload-free. Do
not put Task text, Alert text, raw semantic results, or model content into it.
Real Pi Session records already retain tool content and details. A new
production payload trace requires a separate privacy and retention decision.

### Current model-surface ergonomic rules

Use `ensure_worker` in current code, schemas, skills, tests, and generated
artifacts. Retired tool names stay out of the current surface and remain only
in dated historical evidence.

Preferred plan: replace `alert_send.to` and its magic `"*"` value with a
discriminated target:

```ts
type AlertTarget =
  | { kind: "worker"; name: WorkerName }
  | { kind: "team" };
```

Only an `announcement` accepts the Team target. `clarification` and `attention`
accept one Worker target. The provider schema must explain and reject invalid
combinations before execution. The smaller alternative keeps `to` and adds an
explicit schema rule for `"*"`; choose it only if provider tests reject the
discriminated form.

Keep exact Task versions as required safety coordinates. The projection cutover
will remove heavy successful receipts and singleton batch nesting first. After
that cutover, measure `task_update` invalid calls, turns, and latency. If the
call remains too heavy, evaluate a discriminated status-only change that keeps
an exact version and durable journal evidence but does not require replacement
current context. Do not weaken mutation auditability or idempotent replay only
to shorten a schema. Any proposal to make `operation_id` optional must first
prove crash, resume, and receipt-replay safety.

### Implementation plan

1. Add exhaustive TypeBox model-result schemas and pure projectors for all
   semantic variants. Add typed recovery actions for conflicts and sync gaps.
2. Change assembly to validate one semantic result, serialize only the model
   projection into `content`, and retain the raw semantic result in `details`.
3. Replace the generic renderer with exhaustive per-tool collapsed and expanded
   human projectors. Invalid details fail closed.
4. Keep leader and Worker-facing `task_read`, `task_update`, and `alert_send`
   receipts on the same semantic authority. Retire the old envelope, legacy
   normalization, raw model-content echo, recursive rendering, and old leader
   registrations.
5. Keep `ensure_worker` as the current name and keep `alert_send` on the
   discriminated target. Regenerate provider schemas, the contract review, the
   skill, and current documentation from the accepted surface.
6. Maintain an exhaustive semantic-variant matrix. Capture exact model, raw
   machine, collapsed TUI, and expanded TUI projections in the QA artifact.
7. Run focused type and contract tests, `qa:tool-results`, the full release lane,
   and a restarted real-Pi ten-tool session at narrow and normal terminal
   widths. Investigate the structured-event evidence defect separately; a
   renderer change cannot close it.

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

The current Beads adapter scopes each mutation receipt by Team, Task, and
caller-supplied operation ID. It replays only an identical operation fingerprint
and refuses reuse of that operation ID with different input. Expected-version
checks remain preflight reads rather than database-native compare-and-swap
against arbitrary external writers; the adapter verifies post-write authority.
Exposure remains gated on a backend-neutral conformance suite.

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

The model-tool evaluator covers:

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
13. validated model, raw semantic, collapsed TUI, expanded TUI, and QA-trace
    projections for every result variant;
14. provider schemas that reject forbidden fields, invalid Alert targets, and
    retired locator or compatibility fields;
15. singleton Task results without batch nesting and ordered multi-Task outcomes;
16. exact current Task and typed retry coordinates for Task version conflicts;
17. sync-gap recovery with no baseline advance or fabricated entity counts; and
18. semantic outcomes kept separate from thrown execution and provider errors.

Measure model-facing bytes and tokens, invalid calls, extra turns, warm-up
quality, time to leader decision, missed or duplicate changes, current-context
staleness, and scale behavior.

## Current frontier

1. Complete the fresh full-suite and QA projection gates before publication.
2. Repair or explain the repeated
   `structured_task_event_evidence_absent` gap with external runtime evidence.
3. Keep the Team implementation-version fence and authoritative Task rescan as
   release requirements for mixed writers and lost event publication.
4. Run the focused checks and exact-tree independent release lane.
5. Publish only after the clean package install, real-Pi projection smoke, and
   external verification pass.

Reversal condition: expose a cursor, filter, paging control, or entity count
limit only when a real leader workflow cannot be served safely without it.
