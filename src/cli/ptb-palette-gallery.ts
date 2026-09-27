#!/usr/bin/env node
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import {
  createPtbPaletteComponent,
  PTB_PALETTE_TABS,
  type PtbPaletteSelection,
  type PtbPaletteTab,
} from "../../extensions/ptb-palette";
import { buildPtbPaletteItems } from "../../extensions/ptb-palette-items";

/** Render the production palette against fixed mock settings for review. */
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    process.stderr.write("Width and rows must be positive integers.\n");
    process.exit(2);
  }
  return parsed;
}

const mockNamespace = {
  default_model_role: "review",
  model_roles: {
    review: { model: "example/review", thinking: "high", use: "Complex review" },
    quick: { model: "example/quick", thinking: "low", use: "Short tasks" },
  },
  team: {
    auto_sync_enabled: true,
    auto_sync_delay_seconds: 8,
    auto_sync_update_threshold: 2,
    wait_seconds: 120,
    pane_layout: { leader_share: 0.6, worker_tiling: "linear" },
  },
  worker: {
    tools: { enable: ["read"], disable: ["bash"] },
    agents: { replace_global: "/example/AGENTS.md" },
  },
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write([
    "Usage: ptb-palette-gallery [--tab Actions|Models|Team|Workers] [--plain] [--width N] [--rows N] [--ansi]",
    "Review the production /ptb palette with fixed mock settings. No Team or settings operation runs.",
    "Interactive: Tab/Shift+Tab sections · arrows rows · Enter/Space preview selection · Esc or q quit",
    "",
  ].join("\n"));
  process.exit(0);
}

const requestedTab = argument("--tab");
if (process.argv.includes("--tab") && !PTB_PALETTE_TABS.includes(requestedTab as PtbPaletteTab)) {
  process.stderr.write(`--tab must be ${PTB_PALETTE_TABS.join(", ")}.\n`);
  process.exit(2);
}
const initialTab = (requestedTab ?? "Actions") as PtbPaletteTab;
const width = positiveInteger(argument("--width"), 80);
const rows = positiveInteger(argument("--rows"), 24);
const items = buildPtbPaletteItems({
  namespace: mockNamespace,
  scope: "global",
  trusted: true,
  teamName: "demo-team",
  role: "team-lead",
});
const galleryTheme = (ansi: boolean) => ({
  fg: (color: string, text: string) => !ansi ? text
    : `${color === "accent" ? "\x1b[36m" : "\x1b[2m"}${text}\x1b[0m`,
  bold: (text: string) => ansi ? `\x1b[1m${text}\x1b[0m` : text,
}) as Theme;
const subtitle = "Mock Team: demo-team · team-lead · no live Team changes";
const scope = "Editing global example values · changes affect only future Teams and Workers";

if (process.argv.includes("--plain") || !process.stdin.isTTY || !process.stdout.isTTY) {
  const theme = galleryTheme(process.argv.includes("--ansi"));
  const component = createPtbPaletteComponent({ items, isCurrent: () => true, initialTab, subtitle, scope }, {
    requestRender: () => undefined,
    terminalRows: () => rows,
  }, theme, () => undefined);
  process.stdout.write(`${component.render(width).join("\n")}\n`);
} else {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, false);
  const theme = galleryTheme(true);
  let component: ReturnType<typeof createPtbPaletteComponent>;
  let stopping = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    tui.stop();
    await terminal.drainInput(100, 20).catch(() => undefined);
    process.exitCode = 0;
  };

  const show = (tab: PtbPaletteTab, selected?: PtbPaletteSelection) => {
    if (component) tui.removeChild(component);
    component = createPtbPaletteComponent({
      items,
      isCurrent: () => true,
      initialTab: tab,
      subtitle: selected
        ? `Preview selection: ${selected.id}${selected.value ? ` = ${selected.value}` : ""} · nothing saved`
        : subtitle,
      scope,
    }, {
      requestRender: (force) => tui.requestRender(force),
      terminalRows: () => terminal.rows,
    }, theme, (selection) => {
      if (selection) queueMicrotask(() => show(selection.tab, selection));
      else void stop();
    });
    tui.addChild(component);
    tui.setFocus(component);
    tui.requestRender(true);
  };

  tui.addInputListener((data) => {
    if (data === "q" || data === "Q" || matchesKey(data, "ctrl+c")) {
      void stop();
      return { consume: true };
    }
    return undefined;
  });
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("SIGHUP", () => void stop());
  show(initialTab);
  tui.start();
}
