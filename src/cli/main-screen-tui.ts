import * as piTui from "@earendil-works/pi-tui";
import type { Terminal, TUI } from "@earendil-works/pi-tui";

type MainScreenTuiConstructor = new (terminal: Terminal, showHardwareCursor?: boolean) => TUI;

/**
 * Create a TUI that renders into the terminal's main screen. Pi-tui 0.84 moved
 * this class from `TUI` to `TuiMainScreen` and kept `TUI` as a type only. These
 * CLIs resolve pi-tui independently of the host Pi, so support both exports.
 */
export function createMainScreenTui(terminal: Terminal, showHardwareCursor?: boolean): TUI {
  const exports = piTui as unknown as Record<string, unknown>;
  const Tui = (exports.TuiMainScreen ?? exports.TUI) as MainScreenTuiConstructor | undefined;
  if (typeof Tui !== "function") throw new Error("@earendil-works/pi-tui exports neither TuiMainScreen nor TUI.");
  return new Tui(terminal, showHardwareCursor);
}
