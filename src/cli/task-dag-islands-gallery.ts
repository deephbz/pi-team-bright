#!/usr/bin/env node
import path from "node:path";
import { ProcessTerminal, TUI, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { TaskGraphPaneComponent } from "../task-graph-view/component";
import {
  DEFAULT_TASK_DAG_ISLANDS_GALLERY_CONFIG,
  loadTaskDagIslandsGalleryConfig,
  type TaskDagIslandsGalleryConfig,
} from "../task-graph-view/gallery-config";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const stripAnsi = (line: string): string => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");

class TaskDagGalleryComponent implements Component {
  constructor(private readonly graph: TaskGraphPaneComponent, private readonly color: boolean) {}

  invalidate(): void { this.graph.invalidate(); }
  handleInput(data: string): void { this.graph.handleInput(data); }
  render(width: number): string[] {
    const footer = truncateToWidth("Gallery shortcuts: q quit · use the graph shortcuts above to inspect every island", width);
    const lines = [...this.graph.render(width), this.color ? `\u001b[2m${footer}\u001b[0m` : footer];
    return this.color ? lines : lines.map(stripAnsi);
  }
}

function createComponent(
  config: TaskDagIslandsGalleryConfig,
  options: { rows: () => number; requestRender: () => void; color: boolean; width: number },
): TaskDagGalleryComponent {
  const graph = new TaskGraphPaneComponent({
    source: config.source,
    initialLimit: config.initial_limit,
    terminalRows: () => Math.max(6, options.rows() - 1),
    requestRender: options.requestRender,
    now: () => Date.parse(config.review_now),
    color: options.color,
  });
  graph.render(options.width);
  if (config.start_mode === "select") graph.handleInput("\t");
  if (config.expand_selected) graph.handleInput("\r");
  return new TaskDagGalleryComponent(graph, options.color);
}

const configPath = path.resolve(argument("--config") ?? DEFAULT_TASK_DAG_ISLANDS_GALLERY_CONFIG);
let config: TaskDagIslandsGalleryConfig;
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
  const component = createComponent(config!, {
    rows: () => rows,
    requestRender: () => undefined,
    color: process.argv.includes("--ansi"),
    width,
  });
  process.stdout.write(`${component.render(width).join("\n")}\n`);
} else {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, false);
  const component = createComponent(config!, {
    rows: () => terminal.rows,
    requestRender: () => tui.requestRender(),
    color: true,
    width: terminal.columns,
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
  terminal.setTitle(`Task DAG islands gallery: ${config!.name}`);
  tui.start();
}
