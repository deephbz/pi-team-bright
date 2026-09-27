# Review the terminal displays

These source-checkout programs let maintainers review PTB-owned rendering with
synthetic inputs. They use the production message projections and graph pane.
They do not read or change live Teams and need no model or Beads process.

## Message browser

```sh
npm run review:tui
npm run review:tui -- --help
npm run review:tui -- --scenario custom.framework-sync
```

Use `h`/`l` or left/right to select a scene, `j`/`k` or up/down to scroll,
`Ctrl+O` to toggle detail, and `q` to quit. The help output lists scene IDs.
A selected scene is the initial position in the interactive browser.

The catalog covers every result kind for the nine tool families, registered
custom-message identities, and curated success, refusal, warning, and malformed
input examples. Tool headers and results appear together. Generated result
samples provide variant coverage; curated scenes provide readable examples.
This is representative display coverage, not every possible payload. Pi owns
ordinary user-message rendering, settings dialogs, and command notifications;
those native surfaces must also be reviewed in Pi when they change.

## DAG and Timeline browser

```sh
npm run review:graph
npm run review:graph -- --view timeline
```

Press `v` to switch between DAG and Timeline. The pane's own HUD lists its
selection, detail, filter, pan, and zoom controls. Press `q` to quit.
Both views use the same mock source and fixed review clock. The fixture includes
multiple graph islands and closed, open, blocked, superseded, and unavailable
Attempt timing. It is a display catalog, not an execution trace.
Use `--config FILE` to review another validated graph-view fixture.

## Deterministic exports

```sh
npm run review:tui -- --format plain --width 80
npm run review:tui -- --scenario custom.framework-sync --format json --expanded
npm run review:graph -- --plain --view dag --width 120 --rows 42
npm run review:graph -- --plain --view timeline --width 80 --rows 24
```

Message exports also support `--format ansi`. Graph exports support `--ansi`.
These outputs help compare layouts; they do not replace a terminal review.
The earlier `qa:tui-messages:gallery` and `task-dag-islands:gallery` commands
remain available.

## Keep the review surface current

1. Change the production renderer or component first. Do not copy its layout
   into a gallery-only renderer.
2. Add or update a representative scene in
   [`tui-message-gallery.ts`](../../src/model-tool-contract/tui-message-gallery.ts),
   or the graph's [mock source](../../src/task-graph-view/gallery/default.json).
   The message coverage check compares scenes with actual renderer registrations.
3. Run `npm run review:check`. Review the affected scenes in a real terminal at
   80 by 24 and 120 by 42. Check collapsed and expanded messages, and both graph
   views. Record the scene, viewport, and visual finding with the change.

[`TuiMessageGalleryComponent`](../../src/model-tool-contract/tui-message-gallery-component.ts)
accepts scenes, terminal height, render, and quit callbacks.
[`createTaskDagIslandsGalleryComponent`](../../src/task-graph-view/gallery-component.ts)
accepts a validated source config, viewport, fixed clock, and initial view.
Both implement Pi's `Component` interface and can be embedded in another TUI.
Importing them does not start a terminal or read Team state. The CLIs own process
and terminal lifecycle. Architecture impact: none; these are maintainer tools.
