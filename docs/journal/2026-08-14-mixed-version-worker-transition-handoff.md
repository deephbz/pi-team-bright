# Mixed-version Worker transition handoff

Date: 2026-08-14

## Current state

The committed repair bridges graph-shaped `task_update` commands to assigned
pre-graph Beads Tasks. It keeps graph authority after the first graph apply.

The new `legacy-graph-task-transition-adapter.ts` maps claim, block, resume,
explicit goal success, and context updates through the existing versioned Beads
adapter. It refuses `goal_failed` and `cancel` with
`legacy_transition_unsupported`, so legacy `closed` or `blocked` state cannot
silently change their meanings.

The bridge checks the exact Task version and current assignee. It validates
current ownership before stale operation replay, so a receipt cannot transfer
Task authority to another Worker. A waiting legacy Task refuses claim as
dependency waiting; it is not reported as blocked. A graph-shaped claim with
current context still uses the Beads claim path. It returns Beads operation
replay receipts. `claimWithResult` now persists Task metadata, which makes an
exact legacy claim replay durable.

The Worker direct tool and the leader Task application both use this bridge
before the first graph revision. After a graph exists, existing graph routing
remains authoritative.

## Changed source

- `src/model-tool-contract/legacy-graph-task-transition-adapter.ts` is new.
- Worker and leader Task update composition use the bridge before graph apply.
- Task update result schemas accept canonical legacy or graph cards and add the
  typed `legacy_transition_unsupported` refusal.
- `src/utils/beads.ts` persists Task metadata during a claim.
- Current context and source-map docs now describe the pre-graph bridge.

## Evidence

Passed for the committed repair:

- `npm run typecheck`
- Focused Vitest checks: 44 tests across Worker transition, Worker binding,
  Task semantic projection, Beads adapter/store, and graph-control smoke files.
  The real-Beads transition check ran alone to avoid unrelated Dolt contention.

The real-Beads mixed-version test proves claim and replay, stale-version
refusal, goal success, goal-failure refusal, block, cancellation refusal,
wrong-assignee refusal, wrong-Worker replay refusal, dependency-waiting
refusal, and switch-to-graph routing.

## Delivery state

The repair is one coherent commit. Do not push, tag, or publish. The Worker
Task tool still cannot close this legacy-created coordination Task, so the lead
must reconcile its state. Architecture impact is `none`: this is an internal
Task-authority compatibility adapter with no component, dependency, or
deployment-topology change.
