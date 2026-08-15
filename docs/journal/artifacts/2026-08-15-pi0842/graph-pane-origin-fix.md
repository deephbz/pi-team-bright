# Graph pane moved-origin fix

Date: 2026-08-15
Task: `pane-origin-fix`
Architecture impact: **none**. This changes an internal Herdr adapter check. It adds no authority, component, store, or topology.

## Observation and change

A live explicit `HERDR_PANE_ID` can remain valid after Herdr moves its pane,
while inherited tab and workspace values remain stale. The old graph-pane
origin contract compared those stale values with a new live pane read and
refused the open.

`TaskGraphPaneOrigin` now carries only the exact pane ID and absolute cwd. The
controller resolves the live tab and workspace from that exact pane before it
splits. It verifies that the returned child shares that live location. It keeps
the resolved location for owned-pane close fencing. Missing or non-exact origin
reads still refuse, and a child that moves after opening still cannot be
closed.

## Verification

- `npx vitest run src/task-graph-view/herdr-pane.test.ts` passed 10 focused
  cases. They cover stale tab/workspace values after a same-pane move,
  missing/non-exact origin refusal, child placement refusal, and moved-owned
  pane close fencing.
- `npm run typecheck` passed.
- A real current-session Herdr canary forced stale inherited tab/workspace
  values while retaining the current exact pane ID. The target worktree opened
  one `--no-focus` graph child, verified its live parent location and `Task
  graph ready` output, then closed only that owned child. The origin remained
  present. No other pane was closed.
