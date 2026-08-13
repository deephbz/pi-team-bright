# Task graph pane prototype result

Date: 2026-08-13
Stage: bounded exploration
Design source: [`../projects/dag-native/task-graph-pane-prototype.md`](../projects/dag-native/task-graph-pane-prototype.md)
Architecture impact: none. This is an optional derived view. It changes no accepted Task authority, scheduling, persistence, or deployment contract.

## Result

The prototype adds `/pi-team-graph [25|50|100|200|all]`. The default is the 50 most recently changed distinct Tasks. The same command toggles the process-owned pane off. The pane uses canonical Task cards plus event-journal activity coordinates, writes a private validated projection, splits the exact originating Herdr pane to the right with `--no-focus`, and runs one standalone Pi TUI process.

The renderer uses `@dagrejs/dagre` 3.1.1 for layered placement and the existing `@earendil-works/pi-tui` peer for differential terminal rendering. It shows waiting, ready, active, blocked, and closed states. A join badge comes only from multiple incoming dependency edges. Gate and repair-loop styling require explicit projection coordinates; the current canonical Task adapter supplies neither, so current live data does not invent them.

The pane is read-only. It has no Task mutation adapter or model tool. It watches the Team event-journal directory as a notification hint, then reads current Task authority again and atomically replaces the derived source. It displays its source revision and filter. Arrow keys or `hjkl` pan, `f` changes the recent limit, `r` changes rank direction, and `Home` resets the viewport.

## Verification

Focused deterministic checks covered source validation and sanitization, status projection, bounded recency, boundary-edge counts, joins, explicit gates and repair loops, Dagre cell output, exact-tab lifecycle, no-focus opening, toggle close, moved-pane refusal, partial-open compensation, and shutdown cleanup.

The benchmark command was:

```text
npm run benchmark:task-graph
```

Thirty warm iterations produced 50-node layout p50 5.698 ms and p95 6.685 ms. The 200-node layout p50 was 24.284 ms and p95 27.763 ms. Cached viewport projection p95 stayed at or below 0.037 ms. These measurements calibrate this host and are not a public performance guarantee.

Focused test command:

```text
npx vitest run src/task-graph-view/source.test.ts src/task-graph-view/layout.test.ts src/task-graph-view/herdr-pane.test.ts src/coordination/event-journal.boundary.test.ts
```

Type smoke command:

```text
npx tsc --noEmit --pretty false
```

## Provenance and license

Research inspected `smarzban/herdr-file-viewer` at commit `8a3efa14eb10f44d4b2c0b8b838b9d74e2aa1d86` in a disposable clone. It is MIT. No source was copied. The prototype adopted only general patterns: an in-process terminal view, injected host operations, explicit toggle ownership, terminal-control neutralization, and host tests.

Dagre 3.1.1 and its Graphlib dependency are MIT. Pi TUI is already a package peer and is MIT. The design record contains the selection evidence and rejected options.

## Limits and next test

Process memory owns the pane coordinate. Reload and shutdown close a still-proven pane instead of persisting private coordinates. If an operator moves the pane, normal toggle refuses to close it. Shutdown removes the private source even when it cannot prove that a moved pane is safe to close.

Initial recency projection reads the full append-only journal once. Layout is cached inside the component, but a source change computes a new layout. The pane does not yet support search, assignee filters, mouse input, cross-process discovery, or incremental activity indexing.

The leader will integrate this branch with graph-control and run repeated real Team canaries. A canary must query the current agent and exact origin pane first, open one graph pane, verify same-tab placement and the fixed `Task graph ready` signal, toggle it off, and prove the origin remains present. It must not inspect or control another terminal location.
