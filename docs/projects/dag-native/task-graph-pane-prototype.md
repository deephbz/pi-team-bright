# Herdr Task graph pane prototype design

Date: 2026-08-13
Stage: bounded exploration inside the DAG-native hardening branch
Problem source: [`graph-control-and-tui-kickoff.md`](graph-control-and-tui-kickoff.md)

## Operator decision

The prototype must stay lightweight and fast. It must use mature layout and
terminal rendering components where they fit, toggle like a sidebar, remain
read-only, and use status styling. Large Team graphs need a bounded recent-Task
view instead of an unbounded default render.

This work tests one narrow question: can a Pi command maintain a useful derived
Task graph in the originating Herdr tab without adding authority or a model
tool? It does not ratify a final graph schema or public UI.

## Concept and data flow

```text
Task authority ──read──> canonical Task cards
Team event journal ──read──> ordered Task activity coordinates
future graph control records ──adapt──> explicit gate and repair coordinates

canonical records ──project──> TaskGraphViewSource (ephemeral JSON)
TaskGraphViewSource ──recent filter──> visible graph
visible graph ──Dagre layout──> cell coordinates
cell coordinates ──Pi TUI component──> styled terminal pane

origin pane + exact tab ──Herdr --no-focus split──> graph pane
same Pi command ──verified owned-pane close──> no graph pane
```

`TaskGraphViewSource` is a derived, machine-readable transport. Version 3
contains only fields needed to draw and inspect the graph: Task identity, title,
assignee, status, dependency state, typed edges, activity order, goal, current
context, Attempt/model summary, first and last committed Task-event times, and
source revision. It contains no filesystem coordinates, Membership coordinates,
scheduling decisions, evidence bodies, or mutation capability. Goal and context
remain bounded by the canonical Task contract and enter the transport only so a
selected node can show its Task details.

The renderer derives these presentation states and no others:

- `waiting`: an open Task whose canonical dependency state is waiting;
- `ready`: an open Task whose canonical dependency state is ready;
- `active`: an in-progress Task;
- `blocked` and `closed`: the corresponding canonical Task status;
- `join`: a structural badge when more than one dependency enters a Task;
- `gate`: only an explicit source role, never a title or status inference;
- `loop`: only an explicit repair edge, never a dependency cycle inference.

Unknown, incomplete, or contradictory coordinates refuse at the source boundary.
The view never repairs them.

## Stack selection

Web research used primary project, package registry, and Graphviz documentation
on 2026-08-13.

Use `@dagrejs/dagre` for layered directed-graph layout. Dagre states that speed
on medium graphs and renderer independence are design priorities, supplies node
and edge coordinates, and supports rank direction and spacing controls
([Dagre wiki](https://github.com/dagrejs/dagre/wiki)). Version 3.1.1 is MIT,
its repository remains active, and its npm package is about 1.4 MB unpacked plus
the roughly 0.47 MB MIT Graphlib dependency. Registry evidence showed about
15 million downloads in the preceding month.

Use the existing `@earendil-works/pi-tui` peer for the pane process. It already
provides terminal input, resize handling, ANSI-safe width helpers, synchronized
output, and differential rendering
([Pi TUI README](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)).
The graph component owns graph-to-cell projection, orthogonal route
rasterization, panning, spatial node selection, bounded detail expansion,
filtering, legends, and status styling.

Do not use Graphviz in the first canary. Graphviz is mature and its `plain`
format is a good layout boundary
([plain output](https://graphviz.org/docs/outputs/plain/)), but `dot` is absent
on the canary host. The WASM packages add roughly 2.1–5.0 MB before terminal
rendering. Graphviz 13 also has `-Tascii`, but it requires an AAlib-enabled
native build ([ASCII output](https://graphviz.org/docs/outputs/ascii/)). A later
adapter can replace Dagre without changing the view source.

Reject ELK.js for this prototype. Its stronger layout surface costs about 8 MB
unpacked and its extra features are not yet required. Reject OpenTUI 0.5.2 for
now: it is promising and fast, but adds about 13.3 MB, native Zig bindings, and
a Bun-first toolchain. Reject Terminal Kit because its roughly 4.1 MB package
and dependency set duplicate the existing Pi TUI peer. Reject Blessed because
the current npm release is from 2015. Ratatui and Bubble Tea are mature, but a
new compiled side binary would add packaging work before the interaction shape
is known.

Keep React Flow as a reversal option, not the default. It is a mature web graph
surface, but a local web server and browser tab would add lifecycle, security,
and navigation boundaries that an exact Herdr side pane avoids.

The inspected `smarzban/herdr-file-viewer` reference is MIT at commit
`8a3efa14eb10f44d4b2c0b8b838b9d74e2aa1d86`. Its useful patterns are one
in-process TUI, injected host commands, explicit toggle lifecycle, terminal
control neutralization, and hermetic host tests. No source will be copied, so
its copyright notice does not enter this package. Dagre and Pi TUI are MIT
package dependencies.

## Graph-control adaptation

The integrated graph-control contract now has a direct renderer projection in
[`src/task-graph-view/source.ts`](../../../src/task-graph-view/source.ts). Its
version 2 transport distinguishes `graph_control` from `legacy_task_cards`.
Graph-control sources render the seven controller states, typed success and
failure edges, failure traversal bounds, joins, and selected Attempt/model
coordinates. Legacy `closed` remains `legacy_completed`; the view never
certifies it as goal achievement.

[`TaskGraphPaneService`](../../../src/task-graph-view/integration.ts) accepts an
optional durable graph-control trace reader. Current composition does not inject
one because graph-control persistence is not integrated. The real-Team command
therefore keeps reading canonical Task cards and labels the fallback visibly.
Exact verification, canary instructions, and remaining gaps are in the dated
[adaptation result](../../journal/2026-08-13-task-graph-pane-graph-control-adaptation.md).

## Pane and process lifecycle

The Pi command captures the originating `HERDR_PANE_ID`, `HERDR_TAB_ID`, and
workspace identity. Before each action it gets the exact origin pane and proves
that all three coordinates still agree. It never asks which pane has focus.

Opening does this:

1. Write the validated view source to a mode-`0600` temporary file by atomic
   rename.
2. Split the exact origin pane to the right with `--no-focus`.
3. Parse the new pane ID from Herdr JSON, then get it and prove that its tab and
   workspace equal the origin.
4. Start the package-owned graph process with shell-quoted fixed program and
   file arguments. Retry only Herdr's explicit transient shell-busy result.
5. Rename only the created pane and start an event-driven source refresh.

A repeat command verifies the process-owned pane still shares the exact tab and
workspace, then closes only that pane. A missing pane is safe to forget. A pane
that moved is not closed, moved, or replaced; the command refuses and reports
why. A partial open closes only the pane created by that attempt. Session
shutdown stops watchers, closes a still-proven owned pane, and removes the
temporary source. No pane ID or machine path enters tracked content.

The prototype keeps ownership in process memory. Pi reload closes the pane
rather than persisting a private terminal coordinate. Cross-process discovery
is a later concern if the toggle proves valuable.

## Large graph behavior

The default view selects the 50 most recently changed distinct Tasks from the
ordered Team event projection. It keeps edges only when both endpoints are
visible and reports omitted nodes and boundary edges. It does not relabel an
omitted prerequisite as complete or ready.

The pane can switch among bounded recent limits and an explicit all view.
`Tab` switches between canvas-pan and node-selection modes. `hjkl` and arrows
pan the canvas in pan mode, but choose a stable spatial neighbor in selection
mode. Enter expands only the selected node. Layout and the rendered canvas are
cached by source revision, filter, direction, terminal size, and a bounded time
bucket. Panning and selection do not rerun Dagre. Input caps protect the pane
from malformed or unexpectedly large source documents, and each omission is
visible in the HUD.

The initial activity projection reads the append-only event journal once. This
is linear in journal history. Incremental tail indexing is a known limit, not a
claim that the source path is already optimal at arbitrary history size.

## Safety boundary

Task titles, assignees, and IDs are untrusted display text. The source parser
bounds every collection and string, rejects duplicate or dangling coordinates,
and removes terminal control characters before styling. User data never enters
a shell command or ANSI control sequence.

The graph process reads one projection file. It has no Task mutation adapter,
model tool, Team lifecycle operation, alert operation, or terminal focus
operation. Rich colors and badges are presentation only. The source revision
and last Task-event time remain visible so freshness is inspectable. Node
elapsed time uses the first and last committed Task events: terminal states
freeze at the last event, nonterminal states advance to render time, and absent
history stays visibly unknown.

## Predicted checks

Before measuring, the expected warm layout plus cell projection is under 25 ms
for 50 nodes and under 150 ms for 200 nodes on the canary machine. Cached pan
renders should remain under 5 ms. These are prototype calibration targets, not
public performance promises.

Deterministic tests must cover:

- waiting, ready, active, blocked, and closed status projection;
- an explicit gate, a repair loop, and a multi-input join;
- recent limits, omitted-edge accounting, and stable ordering;
- malformed, duplicate, dangling, and terminal-control input;
- exact-tab open, `--no-focus`, toggle close, moved-pane refusal, partial-open
  compensation, and shutdown cleanup;
- a fixed 120×42 full-component sentinel artifact plus focused layout benchmarks.

A bounded live canary may create one pane from the current exact Herdr pane,
verify its tab and output through Herdr queries, toggle it off, and prove the
origin pane remained present. The canary must not inspect or control another
terminal location.
