#!/usr/bin/env node
import path from "node:path";
import { ProcessTerminal, TUI, matchesKey } from "@earendil-works/pi-tui";
import { createTaskDagIslandsGalleryComponent, type TaskGraphGalleryView } from "../task-graph-view/gallery-component";
import {
  DEFAULT_TASK_DAG_ISLANDS_GALLERY_CONFIG,
  loadTaskDagIslandsGalleryConfig,
} from "../task-graph-view/gallery-config";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: task-dag-islands-gallery [--config FILE] [--view dag|timeline] [--plain] [--width N] [--rows N] [--ansi]\n");
  process.stdout.write("Mock, fixed-clock review of the production Task DAG and Timeline. Press v to switch views in the TUI.\n");
  process.exit(0);
}

const viewArgument = argument("--view");
if (process.argv.includes("--view") && viewArgument !== "dag" && viewArgument !== "timeline") {
  process.stderr.write("--view must be dag or timeline.\n");
  process.exit(2);
}
const initialView: TaskGraphGalleryView = viewArgument === "timeline" ? "timeline" : "dag";

const configPath = path.resolve(argument("--config") ?? DEFAULT_TASK_DAG_ISLANDS_GALLERY_CONFIG);
let config: ReturnType<typeof loadTaskDagIslandsGalleryConfig>;
try {
  config = loadTaskDagIslandsGalleryConfig(configPath);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const plain = process.argv.includes("--plain") || !process.stdin.isTTY || !process.stdout.isTTY;
if (plain) {
  const width = positiveInteger(argument("--width"), 120);
  const rows = positiveInteger(argument("--rows"), 42);
  const component = createTaskDagIslandsGalleryComponent(config!, {
    rows: () => rows,
    requestRender: () => undefined,
    color: process.argv.includes("--ansi"),
    width,
    view: initialView,
  });
  process.stdout.write(`${component.render(width).join("\n")}\n`);
} else {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, false);
  const component = createTaskDagIslandsGalleryComponent(config!, {
    rows: () => terminal.rows,
    requestRender: () => tui.requestRender(),
    color: true,
    width: terminal.columns,
    view: initialView,
  });
  tui.addChild(component);
  tui.setFocus(component);

  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    tui.stop();
    await terminal.drainInput(100, 20).catch(() => undefined);
    process.exitCode = code;
  };
  tui.addInputListener((data) => {
    if (data === "q" || data === "Q" || matchesKey(data, "ctrl+c")) {
      void stop(0);
      return { consume: true };
    }
    return undefined;
  });
  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
  process.once("SIGHUP", () => void stop(0));
  terminal.setTitle(`Task DAG and Timeline gallery: ${config!.name}`);
  tui.start();
}
