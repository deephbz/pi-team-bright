# Ensure reconciliation critical-path continuation

Assigned Task: `ptb-worker-startup-opt-ami` at version
`v_06d1999268de25cb`.

The Task is ready and assigned to `startup-path-engineer`. A normal Worker
`claim` was attempted and failed with the known mixed-version error: the
legacy Task mutation surface rejects graph-native Worker mutation. The lead
has directed source work to proceed and will reconcile Task state.

## Goal and decision gate

Remove the synchronous Task ready-delivery reconciliation from model-tool
`ensure_worker` only if delivery remains complete. `ensure_worker` is Team
lifecycle/topology work. It must not become a Task-authority scan. Do not add
an unfenced background promise. Preserve exact Session admission.

The timing correction is material: Pi Session assistant-to-toolResult deltas
include model and message time. Use semantic traces and authority-read evidence
instead. Existing evidence says a first create produced one legacy `task_list`
trace of 293--1232 ms, ten later reused ensures produced no `task_list`, and
bridge reuse was 9.883--16.525 ms.

## Source observations before implementation

The assigned worktree tip was `1fdac31` (`perf: use model registry for Worker
defaults`), with no uncommitted source changes before this handoff. Task zfv
was later integrated by the lead as `bb1fcf8`; do not edit another worktree.

The current synchronous critical-path call is in
`src/model-tool-contract/durable-model-tool-team-application.ts`:
`await this.taskOrchestration?.reconcileReady(bound.teamName)` after the launch
bridge returns and before the `ensure_worker` result returns.

Delivery ownership already has three bounded paths that must be proven before
removing that call:

1. Graph Task apply and transition invoke `reconcileReady` in
   `src/task-authority/graph-orchestration.ts` after durable Task authority
   mutation. The legacy publishing Beads adapter invokes it after ordinary
   dependency advancement in `src/model-tool-contract/beads-task-adapter.ts`.
2. A Worker `session_start` in `extensions/pi-team-session-adapter.ts` creates
   `TaskChangeDelivery`, gives its managed periodic loop a `reconcileReady`
   callback, starts delivery, then awaits a Worker-specific
   `reconcileReady(teamName, agentName)` once. This is the candidate first
   delivery/recovery path.
3. `src/utils/task-delivery.ts` runs the periodic ready-front recovery through
   its owned `scanOnce` loop. It awaits the callback, catches a failure, keeps
   local delivery alive, and retries on a later bounded scan. This is not an
   unfenced fire-and-forget replacement.

`src/adapters/durable-task-orchestration.ts` serializes periodic Task-authority
reconciliation with the Team `.ready-reconciliation` lock. It opens a durable
Task snapshot and calls `reconcileReadyTaskDeliveries`. The graph orchestration
has its own ready frontier. Inspect both graph and legacy behavior separately.

Trace support is `src/utils/trace.ts` via `PI_TEAMS_TRACE_JSONL`,
`withSemanticTrace`, and `recordBdCall`. Beads command calls record command,
duration, and outcome. Existing source includes task-list traces through
`DurableTaskAuthorityRead`.

## Required continuation work

Read the exact implementations and relevant focused tests next, especially:

- `extensions/pi-team-session-adapter.ts` around the `session_start` delivery
  setup and periodic loop;
- `src/utils/task-delivery.ts` around `TaskChangeDelivery.start` and
  `scanOnce`;
- `src/adapters/durable-task-orchestration.ts`,
  `src/task-authority/graph-orchestration.ts`, and
  `src/model-tool-contract/beads-task-adapter.ts`;
- `src/utils/ergonomic-tool-contract.test.ts`, existing delivery/reconciliation
  tests, and session adapter characterization tests.

Add deterministic tests for: a ready Task that predates a new Worker Session
binding in graph and legacy paths; reused ensure with no Task-authority read;
missed-delivery recovery; reconciliation failure isolation; and no unhandled
background work. Add explicit tool execution instrumentation and authority-read
trace evidence. Add created and reused end-to-end tool timing evidence, while
labeling semantic trace timing separately from Session-message elapsed time.

Expected architecture impact is likely none. Update architecture artifacts only
if accepted authority, responsibility, data flow, or topology changes.

Do not push, tag, publish, or edit another worktree. Commit one coherent change
and send the lead one result Alert with commit, commands, timing distributions,
delivery proof, cleanup, and residual risks. Do not attempt Task closure through
the currently unavailable Worker mutation surface.
