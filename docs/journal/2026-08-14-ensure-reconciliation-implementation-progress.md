# Ensure reconciliation critical-path implementation progress

Task: `ptb-worker-startup-opt-ami` at version
`v_06d1999268de25cb`. The Task remains assigned and open. The graph-native
Worker cannot claim or close this legacy-created Task. The lead will reconcile
state from one final result Alert. Do not attempt another Task mutation.

## Implemented source change

`DurableModelToolTeamApplication.ensureWorker` no longer accepts a Task
orchestration dependency and no longer calls `reconcileReady`. The model-tool
`ensure_worker` operation now returns after the Worker launch bridge result.
The compatibility façade and composition root no longer inject Task
orchestration into the Team application.

Task delivery remains in its Task-owned paths:

- graph apply and transition reconcile their ready frontiers;
- legacy Task mutation reconciles after the Task authority mutation;
- a bound Worker Session performs a named
  `worker_session_ready_reconciliation`;
- the owned Worker delivery loop performs named
  `worker_periodic_ready_reconciliation` and retries bounded failures.

The model-tool registration emits an `ensure_worker` semantic trace. The two
Worker traces distinguish child Session and periodic reconciliation from the
leader tool trace. They are payload-free and preserve existing exact Session
admission.

## Deterministic proof added

Focused changes cover:

- created and reused `ensure_worker` calls with no Task authority read or
  ready reconciliation call, no deferred unhandled work, and two
  `ensure_worker` traces;
- graph and legacy ready-front routing after a first exact Worker Session
  binding, with Worker session admission and reconciliation trace evidence;
- missed ready delivery recovery on the next owned delivery scan;
- ready-front recovery failure isolation from an already queued recipient
  delivery;
- composition/source fences that keep Task reconciliation outside the Team
  topology application.

Checks already passed in the assigned worktree:

- `npm run typecheck`
- `env -u PI_TEAM_MEMBERSHIP_ID npx vitest run --config vitest.exhaustive.config.ts src/utils/ergonomic-tool-contract.test.ts`
- `env -u PI_TEAM_MEMBERSHIP_ID npx vitest run src/utils/pi-session-adapter.characterization.test.ts`
- `env -u PI_TEAM_MEMBERSHIP_ID npx vitest run src/utils/task-delivery.test.ts`
- `env -u PI_TEAM_MEMBERSHIP_ID npx vitest run src/model-tool-contract/durable-model-tool-port.test.ts`
- `env -u PI_TEAM_MEMBERSHIP_ID npx vitest run src/adapters/durable-task-mutation-publication.test.ts`

The `PI_TEAM_MEMBERSHIP_ID` removal is a local Worker-harness isolation step.
The package test setup does not remove that inherited Worker identity.

## Timing evidence and attribution boundary

The executable benchmark is
`scripts/ensure-worker-tool-benchmark.mjs`. It runs a focused Vitest harness,
which writes an isolated exact-Session synthetic-carrier result. Its raw five
sample artifact is
`docs/journal/artifacts/2026-08-14-ensure-worker-tool-benchmark.json`.

The final artifact records created tool wall-clock p50/p95 of 71.0435/73.0265 ms
and reused tool wall-clock p50/p95 of 0.9264/1.3069 ms. It has ten
`ensure_worker` semantic records and no Task-authority semantic operation.
It excludes `team_create`, model/message time, and real child-process startup.

Lead canary evidence must not be over-attributed: its `ensure_worker` call was
4647 ms, `worker_launch` was 2867 ms, and a 1935 ms legacy `task_list` ended
after the leader tool result. The source shows the old leader method awaited
its own reconciliation, but the same Team lock also serializes child
session-start reconciliation. The canary lacks PID/phase correlation, so it
does not prove that `task_list` was the leader scan. The new named traces make
that distinction observable after deployment.

## Remaining work

Run the final focused aggregate from the assigned worktree after this handoff.
Review the new benchmark test and source diff for scope. Add a final journal
result with exact final commands and architecture impact `none`. Then set the
required public privacy Git settings, commit one coherent change, run
`git-privacy-scan --ref HEAD range`, read the Task, and send one result Alert
to `team-lead`. Do not push, tag, or publish.

Residual risks: real production correlation still needs a matching deployed
canary; the child ready-front scan can still wait on its Team lock by design;
and Task-mutation reconciliation remains synchronous Task-authority work.

## Final focused verification

The exact assigned worktree passed the following final aggregate:

```sh
env -u PI_TEAM_MEMBERSHIP_ID npm run typecheck
env -u PI_TEAM_MEMBERSHIP_ID npx vitest run src/model-tool-contract/beads-task-adapter.test.ts
env -u PI_TEAM_MEMBERSHIP_ID npx vitest run src/task-authority/graph-control.integration.smoke.test.ts
env -u PI_TEAM_MEMBERSHIP_ID npx vitest run src/model-tool-contract/durable-model-tool-port.test.ts
env -u PI_TEAM_MEMBERSHIP_ID npx vitest run src/adapters/durable-task-mutation-publication.test.ts
env -u PI_TEAM_MEMBERSHIP_ID npx vitest run src/utils/pi-session-adapter.characterization.test.ts
env -u PI_TEAM_MEMBERSHIP_ID npx vitest run src/utils/task-delivery.test.ts
env -u PI_TEAM_MEMBERSHIP_ID npx vitest run --config vitest.exhaustive.config.ts src/utils/ergonomic-tool-contract.test.ts
env -u PI_TEAM_MEMBERSHIP_ID node scripts/ensure-worker-tool-benchmark.mjs --samples 5
git diff --check
```

Typecheck passed. The focused suites passed 28, 1, 37, 7, 14, 17, and 16 tests.
The benchmark artifact records five created calls at 71.0435 ms p50 and
73.0265 ms p95. It records five reused calls at 0.9264 ms p50 and 1.3069 ms
p95. Its ten `ensure_worker` traces contain no Task-authority operation.

The legacy transition test now proves that a committed legacy Task update calls
its ready reconciliation. The graph transition tests already prove the same
ownership for graph apply and transition. The first Worker Session proof covers
both route selection paths after exact admission. The owned periodic loop
recovers a missed ready frontier and isolates its failure from an existing
recipient delivery.

Architecture impact: `none`. This change removes a duplicate call from the
Team topology path. It does not change Task authority, delivery ownership,
Session admission, component responsibility, or topology.
