import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderProjectionWithTheme } from "./tui-message-projection";
import type { TuiMessageGalleryScenario } from "./tui-message-gallery";
import { createTuiReviewTheme, type TuiReviewThemeName } from "./tui-review-theme";

export interface TuiMessageGalleryComponentOptions {
  scenarios: readonly TuiMessageGalleryScenario[];
  terminalRows: () => number;
  requestRender: () => void;
  quit: () => void;
  expanded?: boolean;
  initialScenarioId?: string;
  theme?: TuiReviewThemeName;
}

/** Browse projected messages. The host owns terminal state and process lifecycle. */
export class TuiMessageGalleryComponent implements Component {
  private readonly scenarios: readonly TuiMessageGalleryScenario[];
  private readonly terminalRows: () => number;
  private readonly requestRender: () => void;
  private readonly quit: () => void;
  private readonly theme: Theme;
  private selected: number;
  private detail: boolean;
  private scroll = 0;
  private lastContentRows = 1;
  private lastViewportRows = 1;

  constructor(options: TuiMessageGalleryComponentOptions) {
    if (options.scenarios.length === 0) throw new Error("The message gallery has no scenarios.");
    const selected = options.initialScenarioId
      ? options.scenarios.findIndex((scenario) => scenario.id === options.initialScenarioId)
      : 0;
    if (selected < 0) throw new Error(`Unknown message gallery scenario: ${options.initialScenarioId}`);
    this.scenarios = options.scenarios;
    this.terminalRows = options.terminalRows;
    this.requestRender = options.requestRender;
    this.quit = options.quit;
    this.theme = createTuiReviewTheme(options.theme ?? "dark");
    this.selected = selected;
    this.detail = options.expanded ?? false;
  }

  invalidate(): void {}

  private move(delta: number): void {
    this.selected = (this.selected + delta + this.scenarios.length) % this.scenarios.length;
    this.scroll = 0;
  }

  handleInput(data: string): void {
    if (data === "q" || data === "Q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.quit();
      return;
    }
    if (data === "h" || matchesKey(data, "left")) this.move(-1);
    else if (data === "l" || matchesKey(data, "right")) this.move(1);
    else if (data === "j" || matchesKey(data, "down")) this.scroll = Math.min(this.scroll + 1, Math.max(0, this.lastContentRows - this.lastViewportRows));
    else if (data === "k" || matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, "ctrl+o")) {
      this.detail = !this.detail;
      this.scroll = 0;
    }
    this.requestRender();
  }

  render(columns: number): string[] {
    const scenario = this.scenarios[this.selected];
    const viewportRows = Math.max(1, this.terminalRows() - 4);
    const content = renderProjectionWithTheme(scenario.message, { expanded: this.detail }, this.theme).render(columns);
    this.lastContentRows = content.length;
    this.lastViewportRows = viewportRows;
    this.scroll = Math.min(this.scroll, Math.max(0, content.length - viewportRows));
    const visible = content.slice(this.scroll, this.scroll + viewportRows);
    const title = `\u001b[1mPi Team Bright TUI message gallery\u001b[0m  ${this.selected + 1}/${this.scenarios.length}  ${scenario.id}`;
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
