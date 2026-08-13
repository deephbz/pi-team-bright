# Task graph pane graph-control adaptation

Date: 2026-08-13
Task: `ptb-graph-native-next-5bq`
Stage: bounded integration prototype on the DAG-native hardening branch
Architecture impact: none for deployed behavior. The pane remains an optional derived view. The graph-control trace seam is not wired to durable authority yet.

## Result

The pane transport now has two explicit source modes. `graph_control` projects the executable `GraphTaskController.trace()` contract. `legacy_task_cards` keeps the existing real-Team command usable until graph-control persistence lands. A legacy `closed` card renders as `legacy_completed`, never as `goal_achieved`.

The graph-control projection renders all controller states: `dependency_waiting`, `ready`, `in_progress`, `blocked`, `goal_failed`, `goal_achieved`, and `cancelled`. Forward edges are explicit `goal_achieved` edges. Failure returns are explicit `goal_failed` edges with current and maximum traversal counts. Multi-input success dependencies derive a join badge. Nodes show Attempt ordinal/count, currentness, Attempt outcome, configured model alias, and resolved model where a display Attempt exists.

The transport remains bounded and read-only. It contains no Task goal, context, evidence text, mutation adapter, model tool, pane focus operation, or private machine coordinate. Current graph activity can use the Team journal. Removed historical Task events remain evidence and are ignored by the current-revision projection.

`TaskGraphPaneService` now has an optional `graphControlTraceReader` seam. The leader can connect durable graph-control reads without changing the renderer or command lifecycle. The current composition does not inject this reader, so `/pi-team-graph` reads canonical legacy Task cards and labels the view `legacy cards (closed ≠ success)`.

## Verification

The final type and renderer commands are:

```text
npm run typecheck
npm run smoke:task-graph
```

The smoke returned schema `task-graph-renderer-smoke/1`. It projected three graph-control Tasks and three typed edges to a 39-by-38 canvas. It proved `in_progress`, `dependency_waiting`, and loop budget `↺0/2` signals. Plain output contained no ANSI control data.

The focused regression command is:

```text
npx vitest run src/task-graph-view/source.test.ts src/task-graph-view/layout.test.ts src/task-graph-view/herdr-pane.test.ts
```

It passed 12 tests. The checks cover every graph-control state, success/failure edges, a traversed repair loop, joins, Attempt/model detail, legacy non-certification, bounded recency, malformed source refusal, deterministic rendering, and exact Herdr pane ownership.

A read-only real-Team source probe against Team `ptb-graph-native-next` returned four canonical cards. The source was explicitly `legacy_task_cards`, with two `in_progress` and two `legacy_completed` nodes. No Task changed.

The final layout benchmark stayed bounded. On this host, 50 nodes had 12.498 ms p95 layout and 0.060 ms p95 viewport projection. For 200 nodes, layout p95 was 39.708 ms and viewport p95 was 0.056 ms. These are calibration results, not public promises.

## Exact command canary

Do this only from a Pi Session that is bound to a real Team and runs this worktree extension. First query the current recognized agent. Use its exact pane, tab, and workspace coordinates. Do not use UI focus.

```text
herdr agent list
herdr agent get <unique-agent-name>
herdr pane get <exact-origin-pane-id>
herdr pane process-info --pane <exact-origin-pane-id>
```

Then run `/pi-team-graph 25` in that exact Pi Session. Verify the split result with installed Herdr commands:

```text
herdr pane layout --pane <exact-origin-pane-id>
herdr pane neighbor --direction right --pane <exact-origin-pane-id>
herdr pane get <returned-graph-pane-id>
herdr pane wait-output <returned-graph-pane-id> --match "Task graph ready" --source recent-unwrapped --lines 80 --timeout 10000
herdr pane read <returned-graph-pane-id> --source recent-unwrapped --lines 80
```

The graph pane must share the origin tab and workspace. The origin pane must remain present. Run `/pi-team-graph 25` again in the same origin Pi Session. Verify only the returned graph pane disappeared and the origin remains. The command itself splits the exact origin with `--no-focus`; it never reads current focus.

This worker did not inspect or control the leader's separate sentinel preview pane. A short same-origin Herdr lifecycle probe created and closed only pane `w4:p1BS` from this worker's exact origin. It proved same-tab placement, `--no-focus`, exact close, and origin survival, but it did not run the extension command because this worker's live Pi process loads another worktree.

## Gaps

The durable graph-control adapter and storage do not exist in this integrated base. Therefore, a current real Team cannot yet supply graph-control Attempts or failure traversal records through the extension command. The optional trace reader is the exact integration seam, but it needs a durable canonical implementation before a graph-control Team canary.

The view shows one current or latest Attempt per Task. Full Attempt history stays in trace data and is not interactive. Search, assignee filtering, incremental journal indexing, and cross-process pane discovery remain outside this slice.
