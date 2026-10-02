#!/usr/bin/env node
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { createMainScreenTui } from "./main-screen-tui";
import {
  exportTuiMessageGallery,
  tuiMessageGallery,
  type TuiMessageGalleryFormat,
} from "../model-tool-contract/tui-message-gallery";
import { TuiMessageGalleryComponent } from "../model-tool-contract/tui-message-gallery-component";
import type { TuiReviewThemeName } from "../model-tool-contract/tui-review-theme";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const scenarios = tuiMessageGallery();
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write([
    "Usage: qa:tui-messages:gallery [--scenario ID] [--expanded] [--theme dark|light] [--width COLUMNS] [--format plain|ansi|json]",
    "Review Pi Team Bright tool results and custom message projections one at a time.",
    "Interactive shortcuts: h/l previous/next · j/k scroll · Ctrl+O detail · q quit",
    "Scenario IDs:",
    ...scenarios.map((scenario) => `  ${scenario.id} — ${scenario.title}`),
    "",
  ].join("\n"));
} else {
  const requestedFormat = argument("--format") as TuiMessageGalleryFormat | undefined;
  const expanded = process.argv.includes("--expanded");
  const scenarioId = argument("--scenario");
  const requestedTheme = argument("--theme") as TuiReviewThemeName | undefined;
  const widthValue = Number(argument("--width") ?? 100);
  const width = Number.isSafeInteger(widthValue) && widthValue >= 40 ? widthValue : 100;

  if (requestedFormat && !["plain", "ansi", "json"].includes(requestedFormat)) {
    process.stderr.write("--format must be plain, ansi, or json.\n");
    process.exit(2);
  }
  if (process.argv.includes("--scenario") && (!scenarioId || !scenarios.some((scenario) => scenario.id === scenarioId))) {
    process.stderr.write("Unknown --scenario. Use --help to list scenario IDs.\n");
    process.exit(2);
  }
  if (requestedTheme && !["dark", "light"].includes(requestedTheme)) {
    process.stderr.write("--theme must be dark or light.\n");
    process.exit(2);
  }

  if (requestedFormat || !process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(exportTuiMessageGallery({ format: requestedFormat ?? "plain", expanded, width, scenarioId, theme: requestedTheme ?? "dark" }));
  } else {
    const terminal = new ProcessTerminal();
    const tui = createMainScreenTui(terminal, false);
    const gallery = new TuiMessageGalleryComponent({
      scenarios,
      initialScenarioId: scenarioId,
      expanded,
      theme: requestedTheme ?? "dark",
      terminalRows: () => terminal.rows,
      requestRender: () => tui.requestRender(true),
      quit: () => {
        tui.stop();
        process.exit(0);
      },
    });
    tui.addChild(gallery);
    tui.setFocus(gallery);
    tui.start();
  }
}
