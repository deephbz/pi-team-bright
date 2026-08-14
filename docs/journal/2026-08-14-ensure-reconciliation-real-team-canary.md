# Ensure reconciliation real-Team canary

Date: 2026-08-14
Stage: hardening
Architecture impact: none
Result: pass for the synchronous reconciliation removal

## Decision

Keep the `ensure_worker` boundary change from source revision `7c4d60f`.
Topology ensure now returns after exact Worker admission. It does not call Task
authority reconciliation.

This is a boundary correction, not an asynchronous shortcut. Task transitions
still dispatch new ready work. Worker Session start repairs work that became
ready before binding. The bounded Worker loop still repairs missed delivery.

## Real-Team evidence

A proxy-backed Pi 0.83.0 coordinator loaded only the exact source extension.
Workers used `openai-codex/gpt-5.6-terra` with medium thinking. Herdr 0.7.5
provided the terminal carrier.

The graph canary first completed one Worker-authored Task. The owned Worker
pane then closed. Before recovery, graph revision 2 retained the terminal Task
and added a ready Task for the absent carrier. One `ensure_worker` call
recovered the same logical Worker. The replacement Worker claimed the ready
Task and recorded `GRAPH_PREEXISTING_READY_PASS`. The Task reached
`goal_achieved` without a leader Task transition.

The legacy canary used a separate Team with no graph. Its Worker pane closed,
then the bound Beads authority received one open assigned Task. This write did
not publish initial delivery. One `ensure_worker` call recovered the same
logical Worker. Session-start repair delivered the Task. The Worker recorded
`LEGACY_PREEXISTING_READY_PASS` and closed it through the mixed-version
transition adapter. The leader did not update the Task.

Both recovery ensures took about 3.1 seconds because they included a fresh Pi
process and exact Session binding. They do not support a 100 ms cold-start
claim.

A third Team made five stable bound-Worker reuse calls. Model-tool
`ensure_worker` took 22–33 ms, with 31 ms p50 and 33 ms p95. The launch bridge
took 10–16 ms, with 13 ms p50 and 16 ms p95. No Task-authority record occurred
between these five calls.

Every Worker-authored result exists in the durable Team event source. Normal
Worker stop and Team shutdown passed. No matching disposable Worker agent
remained.

## Trace interpretation

The named semantic trace shows exact `ensure_worker`, `worker_launch`, Worker
Session admission, Session-start reconciliation, periodic reconciliation, and
Task-authority operations. The source no longer composes Task reconciliation
inside `ensure_worker`.

The trace does not include a process ID or parent operation ID. Therefore, an
unscoped `task_list` record alone cannot identify its process or caller. The
acceptance claim combines the executable source boundary, focused tests, named
Worker traces, durable Worker-authored results, and the real graph and legacy
recovery outcomes. It does not infer ownership from timestamp proximity.

The redacted machine receipt is
[`artifacts/2026-08-14-ensure-reconciliation-real-team-canary.json`](artifacts/2026-08-14-ensure-reconciliation-real-team-canary.json).
Raw traces, Team events, and Pi Sessions remain local. Their SHA-256 anchors are
in the receipt. They contain runtime identities and are not tracked.

## Remaining limits

This canary is a correctness gate for removing the redundant leader scan. It
is not a capacity SLO. The sample is small, and the host had concurrent Team
work.

Fresh Worker startup still takes seconds. The safe fast path is stable bound
Worker reuse. A response near 100 ms can only mean accepted or starting until
exact Session admission completes. Production must not call that state ready.
