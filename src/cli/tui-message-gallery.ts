#!/usr/bin/env node
import {
  ProcessTerminal,
  TUI,
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  exportTuiMessageGallery,
  tuiMessageGallery,
  type TuiMessageGalleryFormat,
} from "../model-tool-contract/tui-message-gallery";
import { projectionAnsi } from "../model-tool-contract/tui-message-projection";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const requestedFormat = argument("--format") as TuiMessageGalleryFormat | undefined;
const expanded = process.argv.includes("--expanded");
const widthValue = Number(argument("--width") ?? 100);
const width = Number.isSafeInteger(widthValue) && widthValue >= 40 ? widthValue : 100;

if (requestedFormat) {
  if (!["plain", "ansi", "json"].includes(requestedFormat)) {
    process.stderr.write("--format must be plain, ansi, or json.\n");
    process.exit(2);
  }
  process.stdout.write(exportTuiMessageGallery({ format: requestedFormat, expanded, width }));
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stdout.write(exportTuiMessageGallery({ format: "plain", expanded, width }));
} else {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, false);
  const scenarios = tuiMessageGallery();

  class Gallery implements Component {
    private selected = 0;
    private detail = expanded;
    private scroll = 0;
    private lastContentRows = 1;
    private lastViewportRows = 1;

    invalidate(): void {}

    private move(delta: number): void {
      this.selected = (this.selected + delta + scenarios.length) % scenarios.length;
      this.scroll = 0;
    }

    handleInput(data: string): void {
      if (data === "q" || data === "Q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        tui.stop();
        process.exit(0);
      }
      if (data === "h" || matchesKey(data, "left")) this.move(-1);
      else if (data === "l" || matchesKey(data, "right")) this.move(1);
      else if (data === "j" || matchesKey(data, "down")) this.scroll = Math.min(this.scroll + 1, Math.max(0, this.lastContentRows - this.lastViewportRows));
      else if (data === "k" || matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
      else if (matchesKey(data, "ctrl+o")) {
        this.detail = !this.detail;
        this.scroll = 0;
      }
      tui.requestRender(true);
    }

    render(columns: number): string[] {
      const scenario = scenarios[this.selected];
      const viewportRows = Math.max(1, terminal.rows - 4);
      const content = projectionAnsi(scenario.message, { expanded: this.detail, width: columns });
      this.lastContentRows = content.length;
      this.lastViewportRows = viewportRows;
      this.scroll = Math.min(this.scroll, Math.max(0, content.length - viewportRows));
      const visible = content.slice(this.scroll, this.scroll + viewportRows);
      const title = `\u001b[1mPi Team Bright TUI message gallery\u001b[0m  ${this.selected + 1}/${scenarios.length}  ${scenario.id}`;
      const mode = `detail: ${this.detail ? "on" : "off"}  rows: ${this.scroll + 1}-${Math.min(content.length, this.scroll + viewportRows)}/${content.length}`;
      const footer = "shortcuts: h/l previous/next · j/k scroll · Ctrl+O detail · q quit";
      return [
        truncateToWidth(title, columns),
        truncateToWidth(`\u001b[2m${scenario.title} · ${mode}\u001b[0m`, columns),
        ...visible,
        truncateToWidth(`\u001b[2m${footer}\u001b[0m`, columns),
      ];
    }
  }

  const gallery = new Gallery();
  tui.addChild(gallery);
  tui.setFocus(gallery);
  tui.start();
}
