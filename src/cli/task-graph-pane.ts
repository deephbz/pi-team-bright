#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { TaskGraphPaneComponent } from "../task-graph-view/component";
import { parseTaskGraphLimit, parseTaskGraphViewSourceJson, type TaskGraphViewSource } from "../task-graph-view/source";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourcePath = argument("--source");
if (!sourcePath || !path.isAbsolute(sourcePath)) {
  process.stderr.write("task-graph-pane requires an absolute --source path.\n");
  process.exitCode = 2;
} else {
  const initialLimit = parseTaskGraphLimit(argument("--limit") ?? "");
  const readSource = (): TaskGraphViewSource => parseTaskGraphViewSourceJson(fs.readFileSync(sourcePath, "utf8"));
  let source = readSource();
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, false);
  const component = new TaskGraphPaneComponent({
    source,
    initialLimit,
    terminalRows: () => terminal.rows,
    requestRender: () => tui.requestRender(),
  });
  tui.addChild(component);
  tui.setFocus(component);
  const elapsedTicker = setInterval(() => tui.requestRender(), 30_000);
  elapsedTicker.unref?.();

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        const next = readSource();
        if (next.source_revision !== source.source_revision) {
          source = next;
          component.setSource(next);
        }
      } catch (error) {
        process.stderr.write(`Task graph refresh refused: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }, 25);
    debounce.unref?.();
  };
  const watcher = fs.watch(path.dirname(sourcePath), (_event, filename) => {
    if (!filename || filename.toString() === path.basename(sourcePath)) refresh();
  });

  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    if (debounce) clearTimeout(debounce);
    clearInterval(elapsedTicker);
    watcher.close();
    tui.stop();
    await terminal.drainInput(100, 20).catch(() => undefined);
    process.exitCode = code;
  };
  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
  process.once("SIGHUP", () => void stop(0));
  process.once("uncaughtException", (error) => {
    process.stderr.write(`Task graph pane failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    void stop(1);
  });
  watcher.on("error", (error) => {
    process.stderr.write(`Task graph source watch failed: ${error.message}\n`);
  });

  terminal.setTitle(`Task graph: ${source.team_name}`);
  tui.start();
  // The lifecycle canary waits for this fixed signal through Herdr output.
  process.stderr.write(`Task graph ready · ${source.team_name} · ${source.nodes.length} tasks\n`);
}
