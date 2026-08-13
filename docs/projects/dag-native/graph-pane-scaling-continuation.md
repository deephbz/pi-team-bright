# Graph pane scaling result

Updated: 2026-08-13
Task: `ptb-graph-native-next-egy`
Task version at last accepted progress update: `v_fd24057d2e3aa177`
Branch: `feature/dag-graph-tui`
Base/last commit: `131766d2ebf4cfabd4a52e561352f9320c638c43`
Stage: hardening; repeated real-pane canaries completed
Status: implementation, focused verification, measurements, and owned-pane canaries pass

## Work contract

Harden the directly Herdr-coupled, read-only graph pane for 20–500 Tasks and many disconnected islands. Preserve canonical graph states, Attempts, typed edges, exact-origin/no-focus lifecycle, visible omissions/freshness, and no model tool or Task mutation. Do not inspect or close the owner's preview pane. Do not edit the graph-control worktree. Commit only after repeated representative measurements and owned-pane canaries stabilize.

Graph-control integration closed at `afbaa35b23e482d30d842c78bab316193b0f6c67`. The renderer boundary is `DurableGraphTaskAuthority.trace(teamName)` under its authority lock. The atomic snapshot is `pi-team-bright-graph-control/1` plus `modelAliases`, graph revisions, logical append-only events, and operation receipts. The pane must watch the graph authority coordinate because Coordination publication has no exact graph outbox.

## Evidence and decisions so far

The initial representative baseline built disconnected five-Task islands with bounded failure-return edges. The first 20-node all-at-once Dagre 3.1.1 layout crashed in `network-simplex` with `Reduce of empty array with no initial value`. This established per-component layout as required behavior, not visual polish. The failure is recorded in the Task journal.

The implementation:

- finds deterministic weakly connected components from visible typed edges;
- lays out each island independently with Dagre using only success/DAG edges;
- routes explicit failure edges in separate right-side lanes, outside Dagre ranking;
- packs islands into deterministic bounded shelves;
- renders island labels and exposes island coordinates on the canvas;
- distinguishes state and edge colors with a 256-color palette;
- marks mixed edge crossings separately;
- adds state filters (`all`, `actionable`, `nonterminal`, `failed`), recent limits, visible omission counts, and boundary-edge counts;
- adds `[`/`]` island navigation while retaining arrows/`hjkl`, `f`, `s`, `r`, and `Home`;
- makes `TaskGraphPaneService` prefer a canonical graph-control source with `hasGraph`, locked `trace`, and `watchPath`, while retaining legacy-card fallback;
- watches both Coordination journal and graph-authority notification coordinates; and
- lets `createPiTeamSessionAdapter` accept the graph-control source for later composition after the control integration lands.

Typecheck passes. The focused source/layout/component/integration/lifecycle lane passes 22 tests. The standalone renderer smoke projects three nodes and three typed edges to a 43-by-34 canvas. Plain output is ANSI-free and contains `in_progress`, `dependency_waiting`, and `↺0/2`.

The final measured disconnected-island benchmark used 15 iterations and five-Task islands:

- 20 nodes, 4 islands, 20 edges: layout p50 2.038 ms and p95 2.578 ms; viewport p50 0.021 ms and p95 0.052 ms; canvas 168×56.
- 100 nodes, 20 islands, 100 edges: layout p50 12.505 ms and p95 13.945 ms; viewport p50 0.024 ms and p95 0.035 ms; canvas 211×230.
- 500 nodes, 100 islands, 500 edges: layout p50 58.623 ms and p95 66.280 ms; viewport p50 0.052 ms and p95 0.062 ms; canvas 211×1158.

These are host calibration results, not public promises.

`src/task-graph-view/source.ts` now requires `authority_sequence` on graph-control sources. It derives this coordinate from the maximum current revision or event sequence. Source freshness includes this coordinate even when Coordination activity does not change. State filtering runs before the recent limit, so “recent 25 actionable” means 25 matching Tasks.

`TaskGraphPaneService` no longer creates missing graph-authority storage. It watches the nearest existing ancestor as a broad notification hint. It moves the watch to the exact parent after that path appears. A focused integration test verifies that opening the pane leaves a missing authority directory absent.

The graph-control composition is not yet wired on this TUI branch because the durable authority classes exist only in the separate control commit. After the leader integrates both commits, `extensions/index.ts` must inject a source equivalent to:

- `hasGraph(teamName) -> graphTaskAuthority.exists(teamName)`;
- `trace(teamName) -> graphTaskAuthority.trace(teamName)`; and
- `watchPath(teamName) -> graphTaskAuthorityPath(teamName)`.

Do not read or decode the snapshot file directly.

## Result source bundle

The coherent change contains:

- `extensions/pi-team-session-adapter.ts`
- `scripts/task-graph-layout-benchmark.ts`
- `src/task-graph-view/component.ts`
- `src/task-graph-view/integration.ts`
- `src/task-graph-view/integration.test.ts` (new)
- `src/task-graph-view/layout.test.ts`
- `src/task-graph-view/layout.ts`
- `src/task-graph-view/source.test.ts`
- `src/task-graph-view/source.ts`
- `src/task-graph-view/component.test.ts` (new)
- this continuation artifact

The control worktree was restored clean after a temporary local composition probe. No control-worktree source change remains.

## Owned Herdr canaries

All canaries used the exact Worker origin and `--no-focus`. Each new pane was parsed from Herdr JSON. Each pane stayed in the origin tab and workspace. Only the exact owned pane was closed. The Worker origin remained unchanged. The owner's preview pane was not read or controlled.

The 20-node canary matched `Task graph ready · canary-20 · 20 tasks`. The visible page showed canonical state, success routes, a labeled failure lane, Attempt/model detail, and navigation help. `]` moved to the next island. An attempted `ctrl-c` Herdr key name failed because the CLI rejected that name. This did not change the pane. The exact owned pane was then closed. This is an operation-interface correction, not a product defect.

The 100-node canary matched `Task graph ready · canary-100 · 100 tasks`. The `]` and `s` inputs completed without layout delay. The visible page showed 20 actionable roots from 100 Tasks. It also showed packed singleton islands, graph-control freshness, and navigation help. The exact pane was closed.

The 500-node canary matched `Task graph ready · canary-500 · 500 tasks` within the 15-second bound. `]` moved to the next packed island. The visible page retained canonical waiting state, typed success/failure routes, Attempt/model detail, and navigation help. The exact pane was closed.

## Handoff

The leader must compose the graph-control source after integrating the control and pane commits. Do not push, merge, tag, or publish from this Worker branch.

## Residual risks to evaluate

- Full source parsing still bounds at 5,000 nodes, 20,000 edges, 100,000 Attempts, and 200,000 events.
- Recent filtering can split islands; boundary counts must stay visible and must not alter canonical state.
- Full Attempt history remains trace-only; nodes show one current or latest Attempt.
- Shelf packing bounds width but can create a tall canvas at 500 Tasks; island navigation must make this usable.
- Dagre runs once per island on each source revision. Panning remains cached, but repeated rapid authority writes can still trigger repeated layouts.
- The graph snapshot is atomic replacement, not an append-only database transaction. The pane consumes the locked authority trace and must not claim stronger durability.
