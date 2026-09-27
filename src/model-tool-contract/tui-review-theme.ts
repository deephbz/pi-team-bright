import type { Theme } from "@earendil-works/pi-coding-agent";

export type TuiReviewThemeName = "dark" | "light";

/**
 * Deterministic theme adapter for the standalone gallery.
 *
 * Pi supplies the full Theme instance in a live Session. The gallery needs
 * only the foreground and background roles used by PTB's production renderer.
 */
export function createTuiReviewTheme(name: TuiReviewThemeName = "dark"): Theme {
  const palette = name === "light"
    ? { label: "\u001b[34m", success: "\u001b[32m", warning: "\u001b[33m", error: "\u001b[31m", text: "\u001b[30m", background: "\u001b[48;5;255m" }
    : { label: "\u001b[36m", success: "\u001b[32m", warning: "\u001b[33m", error: "\u001b[31m", text: "\u001b[37m", background: "\u001b[48;5;236m" };
  return {
    fg(role: string, text: string): string {
      const color = role === "customMessageLabel" ? palette.label
        : role === "success" ? palette.success
          : role === "warning" ? palette.warning
            : role === "error" ? palette.error : palette.text;
      return `${color}${text}\u001b[39m`;
    },
    bold(text: string): string { return `\u001b[1m${text}\u001b[22m`; },
    bg(_role: string, text: string): string { return `${palette.background}${text}\u001b[49m`; },
  } as unknown as Theme;
}
