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

Updated: 2026-08-09

Stage: **hardening**

Status: DAG-native rc.12 candidate on the semantic-hardened subsystem base. The
leader surface has nine tools. `task_create` atomically creates one Task or a
Task DAG. It replaces separate batch creation and model-driven relation edits.
`task_link` is no longer a normal model tool.

Architecture impact: **changed** inside Task authority and the trio-facing
contract. No process, deployment, or trust boundary changed. The post-refactor
port must keep Task policy behind the Task-authority boundary.

## Outcome

Give one leader a small surface for one long-lived Team. The leader creates
stable Workers for cohesive areas. It then commits executable work as Tasks.

A Task DAG can map many Tasks to fewer Workers. Task authority dispatches ready
Tasks mechanically. The leader does not spend model turns on normal dependency
advancement.

Exact Session binding resolves the active Team. The model does not manage Team
locators, cursors, wait durations, paging tokens, backend graph syntax, or
delivery records.

## Ontology and invariants

Tasks are the only executable work authority. One Task has at most one stable
Worker assignee. A Worker can own many Tasks but has one active execution slot.
Use separate Tasks and a join Task when work needs independent Workers.

A dependency links a dependent Task to a prerequisite Task. A dependent Task is
ready only when all active prerequisites are closed. A blocked Task releases
its Worker slot but does not satisfy its dependents.

Delivery proves presentation. It does not prove claim, understanding, progress,
or completion. A Worker must claim a ready Task. A claim with active blockers
refuses and reports their Task IDs.

Worker, Membership, Session, process, pane, Task, delivery, event, and Alert
identities remain distinct. Alerts are exceptional communication. They never
assign or advance work. `team_sync` observes committed state and events. It
never schedules Tasks.

## Model surface

The leader surface has these nine tools:

- `team_create` creates one Team and binds the calling Session as leader.
- `ensure_worker` creates, reconnects, or reuses one stable Worker.
- `task_create` atomically creates or expands one Task DAG.
- `task_read` reads complete current Task cards.
- `task_update` applies one conditional Task mutation with evidence.
- `team_sync` returns a snapshot or incremental coordination changes.
- `alert_send` sends exceptional typed communication.
- `worker_stop` stops a Worker after its nonterminal Tasks resolve.
- `team_shutdown` closes the Team after lifecycle guards pass.

Workers retain their bounded Task and Alert surface. Team topology and lifecycle
mutations remain leader-only.

The executable catalog owns exact parameters and result unions in
[`src/model-tool-contract/catalog.ts`](../../src/model-tool-contract/catalog.ts).
Registration and role filtering live in
[`src/model-tool-contract/pi-registration.ts`](../../src/model-tool-contract/pi-registration.ts)
and [`extensions/index.ts`](../../extensions/index.ts).

## DAG creation intent

One `task_create` call has one operation identity, a keyed Task set, and optional
dependency declarations. Request-local keys let one transaction reference new
Tasks. Exact Task IDs and versions let a later request extend an existing graph.

`task` names the dependent. `needs` names its prerequisites. The Beads adapter
translates this relation to native `blocks` edges. Backend syntax does not leak
through the public contract.

The complete request commits or refuses. It must reject duplicate keys, unknown
references, stale existing-Task versions, unavailable Workers, duplicate or
self edges, cycles, and operation-ID conflicts without partial mutation. An
exact retry returns the prior key-to-Task mapping and never creates duplicates.

After commit, Task authority derives the ready frontier. It reserves at most one
Task-version delivery per free Worker. It persists delivery intent before
presentation. Task closure, blocking, Worker recovery, and process restart must
reconcile the next ready frontier without a leader scheduling call.

The accepted contract and reversal conditions are in
[decision 0010](../decisions/0010-dag-native-task-creation.md). Prototype evidence
is in the
[DAG-native result journal](../journal/2026-08-09-dag-native-prototype-result.md).

## Current Task information

A Task card contains its stable identity, title, goal, status, optional assignee,
replaceable current context, opaque version, outgoing relations, and derived
dependency state. Projection warnings preserve identity when external records
exceed owned display limits.

Current context states what still matters. Journal entries preserve append-only
progress, decisions, blockers, results, and notes. A Task update can replace
current context, append evidence, and change status in one versioned operation.
A stale version or changed replay refuses without mutation.

Snapshots and updates reuse the canonical Task card. A snapshot restores current
orientation. Updates carry new evidence and the latest changed state. `caught_up`
means the exact leader is current at the returned head and no current producer
requires a wait. It does not promise that future changes cannot occur.
`indeterminate` means current run-state or actuation evidence cannot prove a safe
observation; it does not advance hidden position. Hidden observation position is
branch-, Team-epoch-, and Session-specific. Model compaction does not change it.

## Mechanical scheduling and recovery

Dispatch eligibility requires all of these facts:

```text
status is open
assignee exists
all active prerequisites are closed
this Task version has no pending or presented delivery
the assigned Worker has no active execution slot
```

Different Workers can receive the ready frontier in parallel. Several ready
Tasks for one Worker remain queued. Dependencies define required order.
Otherwise, Task authority uses one stable order.

Task authority owns readiness, slot policy, graph replay, delivery intent, and
recovery. Team authority supplies stable Worker and current Membership/Session
resolution. Pi Session actuation only presents committed work. Coordination
observation projects changes but owns no scheduling state.

At-least-once presentation uses Task version and Membership generation identity.
Restart reconciliation must not duplicate Task authority or lose committed work.
The Beads graph-operation receipt is durable commit evidence. An exact replay
queries operation-specific Task evidence, repairs only missing creation or
relation publication, then reconciles ready delivery. A successful exact replay
appends no duplicate event and creates no duplicate Task.

## Result and audience projections

Each tool produces one validated raw semantic result. That result is machine
truth. Pure, allowlisted projections derive:

- compact JSON for the model's next decision;
- concise collapsed TUI output;
- structured expanded TUI output; and
- exact raw/model/TUI QA evidence.

A projection can omit facts but cannot invent or change them. Thrown execution
errors remain distinct from typed refusals and unavailable outcomes. The
payload-free operational trace must not gain Task or Alert text.

The owning sources are
[`src/model-tool-contract/result-projection.ts`](../../src/model-tool-contract/result-projection.ts),
[`src/model-tool-contract/tui-projection.ts`](../../src/model-tool-contract/tui-projection.ts),
and the
[generated contract review](../generated/model-tool-contract-review.html).

## Source allocation

Task-authority DAG meaning, orchestration contracts, ready-front selection, and
portable tests live in [`src/task-authority/`](../../src/task-authority/).
Current Beads translation lives in [`src/utils/beads.ts`](../../src/utils/beads.ts)
and [`src/task-authority/beads-graph-adapter.ts`](../../src/task-authority/beads-graph-adapter.ts).
The consumer-owned durable publication and orchestration adapters live in
[`src/adapters/`](../../src/adapters/). The trio-facing durable port consumes the
Task orchestration boundary and owns no Beads graph or delivery implementation.

Code and tests own exact schemas, variants, state transitions, and limits. This
file owns product intent, boundaries, risks, and reversal conditions. Dated
observations belong in the journal. The one-hop implementation map is
[`docs/reference.md`](../reference.md).

## Verification contract

The executable evidence must cover:

1. exact leader binding and role-specific registration;
2. one-node and multi-node atomic creation;
3. local and existing Task references;
4. cycle, stale-version, Worker, edge, and replay refusal without mutation;
5. exact replay without duplicate Tasks;
6. only ready Tasks presented after commit;
7. active-blocker claim refusal with blocker IDs;
8. automatic successor presentation after a committed transition;
9. parallel dispatch to different Workers;
10. one active execution slot per Worker;
11. blocked-slot release without false dependency satisfaction;
12. graph and pending-delivery recovery after restart;
13. raw, model, collapsed TUI, expanded TUI, and QA projection agreement;
14. unchanged Team, Worker, Alert, and observation behavior outside this cutover;
15. real Beads graph semantics and package-installed behavior; and
16. a real multi-Session Pi canary after the semantic-hardening port.

Measure invalid model calls, extra scheduling turns, ready-to-presentation
latency, duplicate or missed delivery, recovery behavior, and model-facing
bytes. Do not turn benchmark sizes into public count limits.

## Current frontier

The rc.12 candidate is ported to the semantic-hardened boundaries. Task mutation,
graph publication recovery, and ready delivery cross injected consumer-owned
ports. The trio-facing adapter no longer imports Beads graph or Task-delivery
implementation. Pure scheduling tests and real Beads E2E evidence cover atomic
creation, crash recovery, replay silence, active blockers, parallel fronts,
one slot per Worker, blocked-slot release, and automatic successor delivery.

Before branch publication, run the exact full contract, package, external, and
multi-Session Pi lanes. Keep DAG Task-card fields tolerant during the pre-DAG
delivery-record cutover; make them required only after stopped-epoch migration
evidence proves old projections cannot enter the current surface.

Reverse the one-slot default only if measured Worker behavior proves safe
concurrent execution in one durable Session context. Add a separate Workflow
authority or more graph tools only if Task DAGs cannot express a demonstrated
operator decision.
