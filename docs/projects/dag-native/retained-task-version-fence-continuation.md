# Retained-Task version-fence continuation

Updated: 2026-08-13
Task: `ptb-graph-native-next-mh6`
Status: in progress; currentness contract mapped, implementation pending

## Work contract

Fix complete-graph replacement when a retained Task identity receives a new
opaque `TaskVersionRef`. A delivery for the prior version must not remain
presentable or actionable. Apply one exact Task ID plus version currentness
coordinate to delivery, acknowledgement, enqueue recovery, owner-transition
obligations, Coordination projection, and Worker presentation. Preserve all
historical evidence and exact replay or interruption repair. Add focused state
matrix tests and run an exact-source real replacement canary before closing.

## Exact base

Worktree: the isolated `feature/dag-native-rc13` checkout.
Accepted repair tip at Task start:
`ab97dba6cc2de06ead5546a001e9ba4e7f88fc7d`.

The removed-Task repair is at
`6647c9bc14178d354c1e52528ed91b72079da3ee`. Its exact replay correction is at
`97499015a746bfd19b948749d7bf166c2e158eed`. Final accepted canary and context
receipts are `6ce9ddf13fddb3a19856f125920e902701c8167c` and the base above.

## Counterexample and owning invariant

A graph revision can retain Task ID `T`, change its definition or derived state,
and therefore produce version `T@v2`. Durable delivery can still contain
`T@v1`. The current fence stores only Task IDs, so it treats both coordinates as
current. The old captured card can reach Worker presentation even though graph
Task mutation correctly refuses its stale expected version.

The invariant is:

> A derived Task obligation is current only when its exact `(Task ID,
> TaskVersionRef)` is in the latest committed complete graph projection.

Task identity names the historical work lineage. Task version names one exact
current projection. Neither coordinate alone is sufficient for actuation.

## Current authority map

Before this Task, `DurableGraphTaskOrchestration.applyGraph` received complete
`mutation.after` cards but sent only Task IDs into
`GraphRevisionRetirementPort`.

The prior `src/utils/graph-revision-retirement.ts` schema `/1` persisted current
and removed IDs. Its currentness query checked only an ID.

`src/utils/task-delivery.ts` already stores exact versions in delivery refs,
recovery records, tombstones, and committed owner-transition projections. Its
enqueue fence, current read, retirement scans, recovery, owner delivery,
staging, successful-turn acknowledgement, and Worker eligibility currently use
ID membership or only a prior retired marker.

Coordination reads complete current cards from graph authority. It already
rescans that complete projection before historical events and computes
projection revisions from full cards. However, event projection groups an old
Task event by ID alone. The complete-graph path must treat a retained-ID event
whose version is no longer current as historical, while still projecting the
new card through the authority-revision change path.

## Selected design

Replace ID-only fence membership with a small typed coordinate:
`{ taskId, taskVersion }`. Persist the complete sorted set and both the graph
revision sequence and latest graph-authority event sequence in each monotonic
fence record. Keep first-write retired ID/version coordinates as immutable
history and cleanup input. Exact replay compares stable graph revision semantics
and does not recompute first-write retirement history.

Upgrade old `/1` fence snapshots safely because they cannot prove exact current
versions. The graph path can repair them on exact replay from complete current
cards. Until repaired, do not treat ID membership as version proof.

All derived stores keep their existing historical records. Revision cleanup
adds retirement coordinates only when the stored exact Task coordinate is not
in the current set. Enqueue and recovery record writes use the same outer fence
lock and require exact currentness. Current reads and Worker presentation filter
again at read time. Successful-turn acknowledgement filters staged records
again, so a replacement between stage and commit cannot acknowledge stale work.
Owner-transition prepared obligations use `beforeVersion`; committed obligations
use `committedTaskVersion`.

Coordination must compare a Task event's exact ref against complete current
cards. A superseded-version event can advance the cursor but cannot project the
new card as if the stale event described it. A genuinely current event still
projects normally.

## Implementation status

The worktree now implements schema `/2` with exact complete current and retired
coordinates. It requires replay of the matching current graph operation to
upgrade `/1`; a later revision cannot overwrite an ID-only fence without that
repair. The separate authority sequence makes same-graph Task transitions
monotonic even when the graph revision number does not change. All
specified delivery, acknowledgement, recovery, outbox, presentation, and
Coordination paths use exact currentness. Apply and every Task transition
advance the fence after authority commit, so ready, in-progress, achieved,
failed-loop, and join projections share the same rule. Focused replacement and
compatibility checks are green; commit and real canary remain.

## Verification plan

Add focused matrix cases for ready, in-progress, goal-achieved, failure-loop,
join, staged, delivered/unclaimed, and retained-ID replacement. Cover enqueue,
recovery, owner-transition, current read, staging, acknowledgement, exact replay,
and interruption repair.

Run typecheck and only focused tests while iterating. Then commit and launch an
isolated exact-source coordinator through `_codex_with_proxy` with
`openai-codex/gpt-5.6-terra:medium`, repaired Worker defaults, `packages: []`,
and the exact integrated extension. Require a Worker-authored launch event.
Replace a retained Task definition before its old delivery can act. Prove stale
presentation and acknowledgement are fenced, the new version remains
claimable, `team_sync` stays coherent, exact replay repairs cleanly, and cleanup
stops the exact Worker and Team. Do not use a fallback Session or mutate
credentials. Do not push, tag, or publish.
