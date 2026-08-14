# Nonblocking accepted-launch supervision continuation

Date: 2026-08-14
Stage: exploration inside the hardened Task-first package
Architecture impact: none so far

## Task and authority state

Task `ptb-worker-startup-opt-2ue`, **Prototype nonblocking accepted launch
supervision**, is assigned to `warm-carrier-experimenter`. It is open and ready
at version `v_f383a61987bae93a`.

The Worker attempted the graph-native `claim`. The Worker surface refused it:
this legacy-created Task has no graph revision. A clarification Alert informed
`team-lead`. Proceed under the assigned Task and send a result Alert for lead
reconciliation. Do not attempt another Task transition unless the authority
surface changes.

## Goal and constraints

Work only in the isolated warm-experiment worktree. Do not change primary
production behavior. Build a disposable source-coupled prototype that returns
`ensure_worker` after all of these facts:

1. an exact Membership is durable and launch-prepared;
2. Herdr accepted the exact carrier actuation;
3. the exact terminal target is durable.

Exact Session binding remains the only Worker admission gate. Model one
operation through `prepared -> accepted -> bound | failed | expired |
cancelled`, with operation identity, Membership/runtime fencing, deadline,
restart reconciliation, and exact cleanup. Measure response and later binding
separately. Test early exit, live-unbound timeout, pane loss, late binding at
timeout, concurrent ensure, leader restart, stop/shutdown, Task delivery before
binding, and stable-Worker reuse. Commit only experiment/prototype/result
artifacts. Do not push or claim 100 ms without p95 evidence.

## Evidence inspected

`HERDR_ENV=1` is present. Before any Herdr control, use its installed CLI help
as authority, then query `herdr agent list` and exact agent/pane records. Do not
use a focused pane implicitly.

The source observed for this historical continuation remained synchronous. In
`src/team-authority/worker-launch-bridge.ts`, the new-Worker path persists a
prepared Membership and event, calls `launchPreparedMembership`, then awaits
`observeLaunchedWorker` before returning. `launchPreparedMembership` persists
the exact terminal target after spawn; its compensation stops only its exact
target and deactivates the prepared Membership. The direct model-tool
application calls Task `reconcileReady` only after the launch bridge returns.

`src/team-authority/team-session-lifecycle-service.ts` proves why the future
supervisor must not admit on accepted actuation: child admission holds the
exact Membership lease, calls runtime admission, writes an exact runtime
generation, binds the durable Session, then records `session_bound`.
`src/utils/worker-startup-observation.ts` currently bounds observation at
3,000 ms and returns only exact Session/runtime evidence.

Decision 0007 remains binding: one current Membership permits at most one live
Pi process generation. Stop and shutdown require exact terminal or runtime exit
evidence.

A later historical commit, `6fdc60a`, is a relevant comparison only. It added
an accepted-start implementation, benchmark, tests, and result artifacts on a
separate branch. Inspect its source and receipts before design; do not copy it
as accepted production behavior.

## Next steps

1. Read the full historical accepted-start source, benchmark, artifact, and
   tests, plus current runtime, terminal, and lifecycle contracts.
2. Write a problem and plan artifact with an explicit operation-state diagram
   before prototype code.
3. Build the prototype in a new benchmark directory. Keep its state durable
   and redacted, and keep all actuation inside owned disposable resources.
4. Run deterministic adversarial cases first. Use a real owned Herdr probe only
   after its contract and cleanup rules are defined.
5. Persist raw results and a recommendation. Commit source and results, then
   send one result Alert to `team-lead`.
