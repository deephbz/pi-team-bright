# Coordination correctness research handoff

Date: 2026-08-07
Stage: shaping for new coordination-liveness behavior inside the otherwise hardened/sharing package
Architecture impact: not yet accepted; expected topology impact is none

No implementation files were changed during this research. The active Pi Team Bright Team is `close-event-analysis`. Its research Tasks are closed. Stable research Workers are `path-auditor`, `test-auditor`, `surface-auditor`, and `sync-designer`.

## 1. Closed-Task `team_sync` screenshot diagnosis

The screenshot's stated root cause does not match `0.17.0-rc.8` or current HEAD. `listTaskIds` maps all records returned by `BeadsTaskStore.list`, and `listRaw` invokes Team-scoped `bd list --all`. An isolated Beads 1.1.0 probe confirmed that `--all` includes closed Tasks. Current HEAD and the rc.8 executable path are identical.

A real invariant gap remains. `projectTaskChanges` silently skips an event when its referenced Task is absent from the supplied current projection, while `DurableModelToolTeamPort` can stage and later acknowledge the batch head. This can advance hidden observation past an unprojected event.

Preferred future repair: after the current event batch is known, hydrate the unique Task IDs referenced by that batch through one canonical multi-ID read, merge or refresh those cards in the projection, and publish no observation if a required Task cannot be hydrated. Keep `--all` for complete snapshots. Do not copy canonical Task cards into events because that would create a second Task authority. Required focused cases are snapshot -> close -> updates, absent referenced hydration with no staging, one batch read rather than N+1, and no Task read for Worker-only events.

## 2. Worker-facing tool surface

Leader and Worker role projections already differ. Leader `alert_send` chooses a Worker or whole-Team target. Worker `alert_send` derives `team-lead` and correctly omits recipient fields.

The incomplete part is Worker `team_name`. It remains visible on `task_read`, `task_update`, and `alert_send`. Worker Alert execution ignores the supplied value. Worker Task execution uses it even though Team, Worker, exact Session, and Membership are runtime-bound authority coordinates. Team identity must be derived and exact-binding checked, not model-selected.

Proposed Worker inputs:

- `task_read({ task_id })`
- atomic claim branch: `task_update({ task_id, operation_id, expected_version, claim: true })`
- normal update branch: `task_update({ task_id, operation_id, expected_version, current_context?, journal_entries?, status? })`, with at least one change
- `alert_send({ kind, text, task_id?, task_version? })`

Keep `task_id`, `operation_id`, and `expected_version`. A Worker can own several Tasks, and replay/version safety is not derivable from current runtime. Do not derive `operation_id` from Pi tool-call identity until crash, resume, and exact retry behavior is proven.

Other findings: the current Worker `minProperties: 4` is neutralized by four already-required fields and does not require a change; claim exclusivity is enforced only during execution; Worker Alert lacks a strict outer `additionalProperties: false`; the schema permits `task_version` without `task_id`; Worker fields duplicate canonical limits and enums; and `alertToolProjection` is dead because its registration variable is never assigned. Binding errors also have inconsistent semantic mapping.

Suggested implementation boundary, if accepted: one exact `resolveCurrentWorkerContext(ctx)` function, shared role-specific Worker schemas, discriminated claim/update input, strict Alert Task reference, and focused normal-start/resume/stale/fork schema tests. This changes the Worker public contract but not depicted topology. The owner has not yet ratified the invariant that one Worker Session can intentionally act only in its one current Team.

## 3. `team_sync` conductor liveness

### Observed current behavior

`team_sync({view:"updates"})` is bounded, not infinite: current `WAIT_MS` is 120 seconds. It first checks hidden observation, current Task projection, Team events, and the Task projection revision. When caught up, it waits only on the Team event journal. A timeout can return an empty updates result.

The current implementation does not decide whether any source can productively change. It also does not schedule a future leader sync after the leader settles. Later Worker Task mutations remain queryable through Team events but do not directly trigger a leader turn by design. Alerts use exact-Session direct delivery and do trigger turns.

Current Worker `ready` is set after a successful turn. It does not mean idle, active, live, or able to make progress. `lastHeartbeatAt` is written at lifecycle hooks and has no periodic producer. Session binding means carrier association, not OS liveness. Current Pi Team Bright therefore cannot correctly classify Worker idle.

Pi 0.83 exposes `agent_start`, `agent_settled`, `ctx.isIdle()`, and `ctx.hasPendingMessages()`. `agent_settled` means no retry, compaction retry, or queued continuation remains. The package currently supports older Pi peers too, so any design that requires `agent_settled` must either raise the minimum supported Pi version or define a conservative compatibility state.

### Required ontology

Do not flatten these dimensions into one `idle` flag:

- `WorkState`: authoritative Task cards, versions, assignment, status, context, and evidence.
- `MembershipState`: exact current Membership generation and Session binding.
- `ProcessEvidence`: exact `{membershipId,pid,startedAt}` generation and bounded absence evidence.
- `WorkerRunState`: `active | settled | unknown | absent`, as runtime observation only.
- `LeaderRunState`: local `active | settled`, from the exact leader Pi lifecycle.
- `ObservationState`: hidden exact Team epoch + Session + branch watermark and any pending unacknowledged result.
- `ObservationDebt`: event-cursor and Task-projection revision changes after the acknowledged watermark.
- `ActuationState`: pending Worker startup, Task delivery, direct Message, or queued continuation that can start a Worker run.
- `NudgeState`: `disarmed | armed | sent/cooldown`, presentation only.

`quiescent` must mean: the leader is caught up, all complete Worker run observations are settled or absent, no Worker actuation is pending, no Worker is starting, and all required evidence reads succeeded. It never means Tasks are complete, no future Alert can arrive, or no external Task writer can act.

### Recommended `team_sync` decision order

1. Replay an existing pending model observation exactly.
2. If no acknowledged baseline exists, return `snapshot_required`.
3. If the Team event cursor or Task projection revision changed, return a complete update immediately.
4. If at least one exact current Worker run is active, or a Worker start/delivery is pending, enter a bounded wait.
5. If the Team is proven quiescent, return immediately with a normal `caught_up`/`no_change` semantic result. Do not call this an invalid request or claim no future event is possible.
6. If activity or authority evidence is incomplete, return an explicit `indeterminate` result or use only a short bounded compatibility wait. Never classify unknown as idle or dead.
7. While waiting, wake on Team event hints, Task-authority/outbox hints, Worker activity transitions, and actuation transitions. Recheck all authorities after every hint. If an active Worker settles without a semantic event, wake and return caught up rather than waiting to the old deadline.
8. Stage a nonempty observation only after a complete projection. Advance the hidden watermark only after Pi persists the model-visible result and the exact branch acknowledges it.

A wait should start only from positive producer evidence. Worker `agent_start` can publish exact-generation `active`; Worker `agent_settled` can publish `settled`. Do not use `turn_end`, because queued follow-ups can remain. Pending delivery records must bridge the interval between delivery acceptance and the next `agent_start`.

The correct watermark is the pair `(teamEventCursor, taskProjectionRevision)`. Event append can fail after Task authority commits, so an event-only nudge or waiter is incomplete. A Task outbox/revision hint or bounded authority rescan must cover silent authority changes. Events remain wake/evidence records, never Task authority.

### Delayed leader sync nudge

The owner's proposed nudge is compatible with the Alert/Task distinction if it is an internal presentation policy, not an Alert.

Eligibility:

- at least one non-leader Task change is after the acknowledged observation watermark;
- the exact leader has been `agent_settled` for the configured delay;
- no pending leader message, active run, or pending `team_sync` result exists;
- the exact Team epoch, leader Membership, durable Session, branch, and debt key still match.

Use a Pi custom message such as `pi-team-bright.sync-nudge`, with `triggerTurn: true` and `deliverAs: "followUp"`. Its compact content should instruct the leader to call `team_sync({view:"updates"})`. It must contain no Task payload, append no Alert event, change no Task state, and advance no observation watermark.

Exclude leader-authored Task mutations already returned in their mutation receipts. Include Worker and other non-leader Task changes. If there is no hidden baseline, the nudge must request a snapshot rather than updates.

Resolve the nudge policy from trusted Pi settings at Team creation and persist the resolved policy in the Team epoch. Do not add timing fields to the model tool call. Candidate policy fields are delay, repeat/backoff, maximum frequency, and policy version. Exact defaults require measurement before acceptance.

Anti-storm key: Team epoch + exact leader Session + active branch + acknowledged watermark + newest unseen Task revision/cursor + policy version. Coalesce bursts. Revalidate before each send. Use exponential cooldown with a bounded maximum frequency. Reset only when the acknowledged watermark covers the debt or the debt key changes. Suppress while the leader is busy or already has a queued message, then re-arm after `agent_settled`.

Nudge presentation evidence must survive reload/resume without becoming authority. Prefer a branch-visible custom-message receipt or a small derived nudge record. On restart, rebuild eligibility from hidden observation plus current event/Task revision, then suppress duplicates already presented on that branch.

### First-stage plan before behavior changes

1. Ratify the ontology and public result meaning. In particular, choose `caught_up` rather than `refused` for proven quiescence.
2. Decide whether Pi 0.83 becomes the minimum for exact `agent_settled` evidence. Otherwise define older peers as `unknown`.
3. Add a shadow evaluator design before behavior: record payload-free wait decisions, activity evidence class, observation debt, pending actuation, wait outcome, and proposed nudge suppression reason. Do not expose raw runtime data to the model.
4. Evaluate with fake clocks and injected sources: no Workers; all settled with unresolved Tasks; active Worker emits a Task change; active Worker settles without a change; pending delivery bridges to active; unknown generation; event check-register race; Task revision without event; leader idle nudge; leader-authored mutation exclusion; Alert/nudge coalescing; branch switch; same-Session restart; Membership replacement; crash before observation acknowledgement; cancellation; and burst coalescing.
5. Run one real two-Session proof of `agent_settled`, exact Session delivery, hidden acknowledgement, and delayed nudge. A trace alone is not proof; assert the model-visible outcomes and durable coordinates.
6. After evidence, ratify timeout defaults, settings shape, public result variants, and compatibility boundary. Only then assign implementation and independent verification Tasks.

## Owner decisions still required

1. Confirm that `quiescent` means no currently scheduled/active producer, not no possible future Team event.
2. Confirm that proven quiescence returns a normal immediate `caught_up` result rather than a refusal.
3. Confirm that automatic sync nudges are internal exact-leader presentation, never Alerts.
4. Confirm whether nudges cover all non-leader Task changes or only current Worker actors. The current recommendation is all non-leader changes.
5. Decide whether exact Worker run-state support can require Pi 0.83.
6. Select the configuration home and measured defaults. Current recommendation is a resolved Team-epoch policy sourced from trusted Pi settings, not model input.

No accepted decision record or evergreen contract was changed. This handoff is evidence and a continuation artifact only.

## Owner decision clarification: sync wait and nudge policy

Date: 2026-08-07
Status: owner-ratified clarification for the coordination-liveness design; implementation remains unassigned.

The owner ratified and superseded the matching open questions above as follows:

1. `team_sync` wait timeout is globally configurable in Pi `settings.json` under the Pi Team settings section, `pi_team_bright.team`. The current 120-second timeout remains the default. Later measured evidence may support an owner-approved change to that default. No model-tool wait field is added.
2. A sync nudge is an internal extension message, not an Alert and not Task authority. Its model-facing result, durable machine record, and TUI-facing rendering must remain coordinated projections of one semantic nudge record, as with other extension messages. The nudge carries presentation intent only; it does not mutate Tasks, append an Alert, or advance observation state.
3. Pi 0.83 is the minimum supported Pi version for this behavior. The design has no backward-compatibility state for older Pi versions. This supersedes the prior compatibility question about representing older peers as `unknown`.
4. Global Pi settings must provide a nudge enabled toggle and nudge delay seconds under the Pi Team settings section. These settings control whether the internal nudge policy can arm and when it may present. This decision does not select unrelated keys or defaults.

These decisions supersede the matching open questions in the preceding `Owner decisions still required` section: configuration home and wait default, nudge transport, and the Pi compatibility boundary. The remaining questions stay open unless this clarification answers them.

## Owner scope clarification: Worker `team_name` removal

For this accepted Worker-tool change, scope is strictly limited to removing redundant model-selected `team_name` fields where exact runtime Team binding replaces them. Keep `task_id`, `operation_id`, `expected_version`, claim and update behavior, Alert capability, role-derived targets, result semantics, topology, and all other tool capability unchanged.

This clarification supersedes section 2's broader suggested implementation boundary for this change. Do not add shared-schema refactors, discriminated input redesign, stricter Alert-reference rules, error-mapping changes, or unrelated cleanup.

## Release-source preparation result

Date: 2026-08-07
Source: `79cea8c893a01b978f38f6e99368537697e9e3cb`
Target: `release/v0.17.0-rc.9` at `/private/tmp/ptb-rc9-release`

The accepted liveness decisions are represented in the rc.9 source and intent
artifacts. The source documents `caught_up` as normal proven quiescence and
`indeterminate` as incomplete evidence with no observation advance. It records
Pi `>=0.83`, global `wait_seconds`, enabled nudges with the `1200` second
default, the narrow Worker surface, and failed-event hint plus Task-revision
completeness. Historical rc.6, rc.7, and rc.8 receipts remain unchanged.

Focused verification passed: JSON metadata validation, model-tool documentation
generation, TypeScript 5.9 typecheck, 71 targeted liveness/event/model-tool
tests, and package observation probing. The generated `dist` changes are release
source and must remain with this commit. No broad suite, publication, tag, push,
or merge was run.

## Accepted blocker integration result

Date: 2026-08-07

The final release source integrates bounded sequential Beads hydration in batches
of at most 16 IDs and returns typed `task_authority_unavailable` results without
staging incomplete observations. It also integrates Pi 0.84 footer subscription
auth validation and binds the exact resumed leader Session before nudge-debt
reads. The resumed-nudge proof diagnoses fork and stale-binding suppression and
one durable/model/TUI presentation.

Integrated blocker commits: `cb6e8bbc61573b295b518e90ee225e6f649f77ff` and
`8e56afc`. The final focused run passed 101 tests across nine files, plus model
documentation generation, TypeScript 5.9 typecheck, JSON validation, and package
verification. No broad suite or publication was run.
