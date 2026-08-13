# Removed-Task graph replacement coherence continuation

Updated: 2026-08-13
Task: `ptb-graph-native-next-pxb`
Last known Task version: `v_1987d1493282dcd0`
Status: in progress; implementation and focused verification complete, real canary pending

## Work contract

Repair complete-graph replacement so removed Tasks cannot remain actionable or
break Coordination. Fence or retire their Coordination references, ready
intents, acknowledgements, owner transitions, recovery records, and pending
Worker presentations. Preserve history and current graph Tasks. Keep replay and
recovery explicit. Add focused adversarial tests, commit, then run a real
replacement canary. Do not push, tag, or publish.

## Exact base

Worktree: this `feature/dag-native-rc13` checkout.

The clean E2E tip before this Task is:

- integration: `84c9c89bec5bc40d94e3975b1347778d29a3c13b`;
- live pane transport repair: `2612fc999eb63c2ac4e1a0bcdb0c425e6051979e`;
- durable E2E result: `40dd197b4200a9e17734f83f20188ec301c229b3`.

The current uncommitted tree implements the revision fence and focused tests on
this base. It has not yet run the real replacement canary or received its final
commit.

## Proven incident

The real Team E2E applied complete pane graphs, then replaced them. Current
graph authority correctly removed old IDs, but Coordination still tried to
hydrate a removed Task such as `i01-n01`. `team_sync` returned
`task_authority_unavailable`. Workers also received ready snapshots for removed
Tasks and got `task_not_found` when claiming them.

Direct graph `task_read` remained coherent. Cleanup used direct reads, completed
the current five-Task lineage, stopped all Workers, and shut down with no
unfinished Task IDs.

## Current authority map

`DurableGraphTaskAuthority.applyGraph` commits the controller snapshot under the
graph lock and returns `before`, `after`, and `ready`. Its transaction does not
include Coordination or delivery stores.

`DurableGraphTaskOrchestration.applyGraph` publishes only created or changed
Tasks from `mutation.after`. It does not publish or retire IDs present only in
`mutation.before`. It then calls `reconcileReady`.

`DurableTaskMutationPublication` implements both mutation publication and ready
delivery. Delivery files, tombstones, recovery records, and owner-transition
outbox are durable stores outside graph authority. Current `TaskReadyDeliveryPort`
only supports reading coordinates and enqueueing ready Tasks; it has no
revision-fence or retirement verb.

`DurableGraphTaskStateDeliveryQuery.listTaskIds` returns current graph IDs.
`readTasks` preserves input shape and returns `undefined` for removed IDs.

`CoordinationObservationService.staleEventTaskIds` marks any event reference
missing from the current baseline as stale, then `hydrateTaskIds` requires every
reference to hydrate. A removed Task therefore becomes an authority-unavailable
error. Its projection merge also only adds/replaces Tasks; it does not remove
baseline Tasks that disappeared from the complete graph.

`TaskChangeDelivery` presents captured `taskProjection` records. It does not
validate each pending record against the current graph revision before staging.
Thus an old delivery remains actionable after replacement.

## Implemented design

`GraphRevisionRetirementPort` is a separate consumer boundary owned by graph
orchestration. The durable publication adapter implements its one idempotent
verb. Authority commit remains first. Orchestration computes `before - after`
and records the complete current set, graph version, monotonic graph sequence,
and operation ID. An exact graph replay retries retirement without republishing
Task mutations.

The durable fence is the immediate read-time authority. Its current coordinate
cannot regress during stale replay. Delivery enqueue and fence mutation use the
same outer fence lock, so work removed by a committed fence cannot enter the
pending spool after that fence. Derived delivery, recovery, and owner-transition
records retain evidence but gain retirement coordinates. Current delivery reads
filter them before presentation and liveness projection.

Coordination now asks its Task query whether `listTaskIds` is a complete current
set. Graph reads answer yes after first graph apply. For such a set, every event
batch gets one complete authority rescan. This subtracts removed Tasks and lets
historical events advance without hydrating removed IDs. Legacy Beads event-only
hydration remains unchanged. A listed current Task that fails hydration still
returns `task_authority_unavailable`.

## Verification and continuation

Focused verification passed on the uncommitted tree:

- `npm run typecheck`;
- seven new replacement/Coordination tests;
- 32 tests across the new files, graph integration smoke, Task delivery, and
  legacy event hydration.

The new tests cover pending and already-staged presentation, retained delivery
history, recovery and owner-transition retirement, monotonic stale replay,
exact replay repair
without mutation republication, historical removed-event sync, and missing
current-Task refusal. A successful-turn acknowledgement remains immutable
historical evidence; the fence prevents it from becoming a current obligation.

Next, self-review the final diff and commit the implementation. Then launch an
isolated exact-source real Team through `_codex_with_proxy` with
`openai-codex/gpt-5.6-terra:medium`. Prove a Worker-authored event, replace a
ready Task before presentation or claim, and capture exact `team_sync`, Worker,
and recovery evidence. Clean up the Team. If the canary exposes a defect, fix
its owning boundary and rerun only that scenario. No push, tag, or publish.
