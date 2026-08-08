# Model-tool release parity checklist

Release: `0.17.0-rc.10`
Source surface: shipped main extension at the release candidate source commit

This checklist maps each `0.17.0-rc.10` coordination capability to the
single durable model-tool leader surface. The leader uses exact Session binding,
so the surface omits `team_name` and carrier controls. Worker processes keep the
narrow `task_read`, `task_update`, and `alert_send` registrations; Worker Team
identity comes from exact runtime binding, not model input.

| Published capability | New leader mapping | Authority and verification |
|---|---|---|
| `team_create` | `team_create({name,purpose,pane_layout?})` | Team/Membership/Beads creation through `DurableModelToolTeamPort`; typed policy resolution and pane-layout tests |
| `team_sync` | `team_sync({view})` | Team events, hidden observation, Team epoch, logical Workers, liveness state, and Beads projection; durable model-tool tests |
| `ensure_worker` | `ensure_worker({name,scope})` | Logical Worker plus existing Worker launch bridge; resource/startup/terminal composition stays in the bridge |
| `task_create` | `task_create({tasks})` | Team-scoped opaque per-item `operation_id` in Beads idempotency metadata; retries return only matching canonical initial Task semantics |
| `task_read` | `task_read({task_ids})` | Model-tool metadata projection over Beads; legacy Task records fail closed as contract gaps |
| `task_update` | `task_update({updates})` | Expected-version preflight, durable operation metadata replay, model-tool metadata, evidence publication, and post-state receipt |
| `task_link` | `task_link({task_id,relation,target_id,action,expected_version})` | Existing Beads relation authority with exact leader binding; graph conflicts and stale versions refuse without mutation |
| `worker_stop` | `worker_stop({worker})` | Existing terminal stop evidence, exact Membership generation, nonterminal Task guard, and Worker event |
| `team_shutdown` | `team_shutdown()` | Existing Team topology/lifecycle authority; stop failures keep current Memberships and permit retry |
| `alert_send` | `alert_send({target,kind,text,task_id?,task_version?})` | Existing typed Alert delivery and event authority; Alerts never mutate Tasks |

## Registration invariants

- The leader registers exactly these ten names once: `team_create`,
  `team_sync`, `team_shutdown`, `ensure_worker`, `worker_stop`, `task_create`,
  `task_read`, `task_update`, `task_link`, and `alert_send`.
- A Worker keeps the current Worker-facing names and does not receive leader
  lifecycle controls.
- Direct role registration owns overlapping names, so no process registers a
  duplicate public name.
- Result content is validated decision-relevant model JSON. Machine details keep
  the exact raw semantic result; collapsed and expanded TUI output uses an
  exhaustive allowlist.
- Old Team records remain readable. Missing epoch or logical Worker coordinates,
  invalid model-tool metadata, and unstructured event evidence fail closed.
- Package release identity never acts as a Team compatibility gate. Historical
  `implementationVersion` values and absent values remain accepted.
- A real incompatible persistence change requires its own schema or capability
  coordinate and an explicit migration or refusal test.

## Focused implementation evidence

- `src/model-tool-contract/catalog.test.ts` validates the ten-tool catalog and
  result schemas, including `team_create.pane_layout`.
- `src/utils/team-pane-layout.test.ts` validates the exclusive
  `0.1 < leader_share < 1.0` range, policy precedence, trust-gated project
  settings, backend support, and immutable default resolution.
- `src/adapters/herdr-adapter.test.ts` validates exact pane placement and the
  deterministic four-Worker 2x2 grid sequence.
- `src/model-tool-contract/first-journey.test.ts` validates registration,
  model JSON, exact binding, batch Task semantics, and replay/conflict behavior.
- `src/model-tool-contract/beads-task-adapter.test.ts` proves matching create
  replay, conflicting operation reuse refusal, and safe recovery after an
  unknown post-authority result.
- `src/model-tool-contract/result-projection.ts` and
  `src/model-tool-contract/tui-projection.ts` validate the raw/model/TUI
  projection boundary.
- `src/utils/tool-surface.test.ts` validates the published ten-tool selection.
- `src/utils/runtime-startup-admission.test.ts`, terminal adapter tests, and
  Worker resource tests remain unchanged composition anchors.
- Release verification must run the complete release lane and clean package
  install against this release without publishing or pushing from this task.

## Coordination liveness and event completeness

- `team_sync({view:"updates"})` returns normal `caught_up` when the leader is
  caught up and no current Worker producer or actuation requires a wait.
- `indeterminate` reports incomplete run-state or actuation evidence and does
  not advance hidden observation. Pi `>=0.83` is the supported peer boundary for
  exact `agent_start` and `agent_settled` evidence.
- Global `pi_team_bright.team.wait_seconds` controls the bounded wait and
  defaults to `120`. Internal sync nudges use the same global section, default
  to enabled, and default to `1200` seconds. Nudge records project one
  exact-leader presentation; they are not Alerts, Task mutations, or watermark
  advances.
- Failed Task-event appends create payload-light hints. Updates also check the
  Task-authority revision, hydrate every referenced Task before publication, and
  publish no observation when required hydration fails. This covers eventless
  authority changes and the check-register race without making events a second
  Task authority.

Focused anchors:

- `test/coord-liveness-e2e/sync-liveness.test.ts` covers caught-up,
  indeterminate, settings defaults, positive hints, cancellation, nudge
  projections, and Pi message rendering.
- `src/utils/task-event-failure-hints.test.ts` and
  `src/utils/tasks-event-publication.test.ts` cover failed-event hint evidence.
- `src/model-tool-contract/durable-model-tool-port.test.ts` covers failed reads,
  hidden-watermark safety, and complete Task hydration.
- `src/utils/sync-nudge-conductor.test.ts` covers post-settle nudges and
  eventless Task revision hints.

Architecture impact: **changed** at the public tool contract boundary. No new
component, authority, persistence store, process boundary, or deployment
boundary was added.
