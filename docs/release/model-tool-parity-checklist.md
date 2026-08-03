# Model-tool release parity checklist

Release: `0.17.0-rc.4`
Source surface: shipped main extension

This checklist maps each `0.17.0-rc.4` coordination capability to the
single durable model-tool leader surface. The leader uses exact Session binding,
so the surface omits `team_name` and carrier controls. Worker processes keep
their existing `task_read`, `task_update`, and `alert_send` registrations.

| Published capability | New leader mapping | Authority and verification |
|---|---|---|
| `team_create` | `team_create({name,purpose})` | Team/Membership/Beads creation through `DurableModelToolTeamPort`; catalog and first-journey tests |
| `team_sync` | `team_sync({view})` | Team events, hidden observation, Team epoch, logical Workers, and Beads projection; durable model-tool tests |
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
- The durable model-tool port refuses to mutate a Team from another implementation epoch.
- One live Team remains one Pi Team Bright version epoch.

## Focused implementation evidence

- `src/model-tool-contract/catalog.test.ts` validates the ten-tool catalog and
  result schemas.
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

Architecture impact: **changed** at the public tool contract boundary. No new
component, authority, persistence store, process boundary, or deployment
boundary was added.
