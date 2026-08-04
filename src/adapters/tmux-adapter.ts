/**
 * Tmux Terminal Adapter
 * 
 * Implements the TerminalAdapter interface for tmux terminal multiplexer.
 */

import { execSync } from "node:child_process";
import { TerminalAdapter, SpawnOptions, execCommand, shellCommand } from "../utils/terminal-adapter";
import { DEFAULT_TEAM_PANE_LAYOUT } from "../utils/team-pane-layout";

export class TmuxAdapter implements TerminalAdapter {
  readonly name = "tmux";

  isDirectCarrier(): boolean {
    return true;
  }

  detect(): boolean {
    // tmux is available if TMUX environment variable is set
    return !!process.env.TMUX;
  }

  currentTargetId(): string | null {
    const paneId = process.env.TMUX_PANE?.trim();
    return paneId ? paneId : null;
  }

  private paneGeometry(paneId: string | null | undefined): { windowId: string; left: number; width: number } | null {
    if (!paneId) return null;
    try {
      const result = execCommand("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}\t#{pane_left}\t#{pane_width}"]);
      if (result.status !== 0) return null;
      const [windowId, left, width] = result.stdout.trim().split("\t");
      const numericLeft = Number(left);
      const numericWidth = Number(width);
      return windowId && Number.isInteger(numericLeft) && Number.isInteger(numericWidth) && numericWidth > 0
        ? { windowId, left: numericLeft, width: numericWidth }
        : null;
    } catch {
      return null;
    }
  }

  spawn(options: SpawnOptions): string {
    if (!options.panePlacement) throw new Error("tmux Worker spawn requires exact Team pane placement.");
    const command = options.argv ? shellCommand(options) : options.command!;
    const legacyEnvArgs = options.argv ? [] : Object.entries(options.env)
      .filter(([k]) => k.startsWith("PI_"))
      .map(([k, v]) => `${k}=${v}`);
    const { leaderPaneId, workerPaneIds } = options.panePlacement;
    const paneLayout = options.panePlacement.paneLayout ?? DEFAULT_TEAM_PANE_LAYOUT;
    if (paneLayout.worker_tiling === "grid") {
      throw new Error("Pane worker_tiling=grid is unsupported by terminal backend tmux; use worker_tiling=linear or a Herdr Team.");
    }
    const workerPaneId = workerPaneIds.at(-1);
    const targetPaneId = workerPaneId ?? leaderPaneId;

    if (!targetPaneId || workerPaneIds.some((paneId) => !paneId || paneId === leaderPaneId)) {
      throw new Error("tmux Worker spawn requires distinct exact Team pane targets.");
    }
    const targetGeometry = this.paneGeometry(targetPaneId);
    if (!targetGeometry) {
      throw new Error(`tmux Team pane ${targetPaneId} is unavailable; refusing to use an ambient pane.`);
    }
    if (workerPaneId) {
      const leaderGeometry = this.paneGeometry(leaderPaneId);
      if (!leaderGeometry || leaderGeometry.windowId !== targetGeometry.windowId
        || targetGeometry.left < leaderGeometry.left + leaderGeometry.width) {
        throw new Error(`tmux Team Worker pane ${workerPaneId} is outside the leader Worker region; refusing to split it.`);
      }
    }

    const tmuxArgs = [
      "split-window",
      workerPaneId ? "-v" : "-h",
      // tmux sizes the new Worker pane. Floor it so the rendered leader keeps
      // at least the requested share when the percentage is not an integer.
      ...(workerPaneId ? [] : ["-l", `${Math.floor((1 - paneLayout.leader_share) * 100)}%`]),
      "-dP",
      "-F", "#{pane_id}",
      "-t", targetPaneId,
      "-c", options.cwd,
      ...(legacyEnvArgs.length > 0 ? ["env", ...legacyEnvArgs] : []),
      "sh", "-c", command,
    ];

    const result = execCommand("tmux", tmuxArgs);
    if (result.status !== 0) {
      throw new Error(`tmux spawn failed with status ${result.status}: ${result.stderr}`);
    }

    return result.stdout.trim();
  }

  kill(paneId: string): void {
    if (!paneId || paneId.startsWith("iterm_") || paneId.startsWith("zellij_")) {
      return; // Not a tmux pane
    }
    
    try {
      execCommand("tmux", ["kill-pane", "-t", paneId.trim()]);
    } catch {
      // Ignore errors - pane may already be dead
    }
  }

  isAlive(paneId: string): boolean {
    if (!paneId || paneId.startsWith("iterm_") || paneId.startsWith("zellij_")) {
      return false; // Not a tmux pane
    }

    try {
      execSync(`tmux has-session -t ${paneId}`);
      return true;
    } catch {
      return false;
    }
  }

  setTitle(title: string): void {
    try {
      const paneId = this.currentTargetId();
      const args = paneId
        ? ["select-pane", "-t", paneId, "-T", title]
        : ["select-pane", "-T", title];
      execCommand("tmux", args);
    } catch {
      // Ignore errors
    }
  }

  /**
   * tmux does not support spawning separate OS windows
   */
  supportsWindows(): boolean {
    return false;
  }

  /**
   * Not supported - throws error
   */
  spawnWindow(_options: SpawnOptions): string {
    throw new Error("tmux does not support spawning separate OS windows. Use iTerm2 or WezTerm instead.");
  }

  /**
   * Not supported - no-op
   */
  setWindowTitle(_windowId: string, _title: string): void {
    // Not supported
  }

  /**
   * Not supported - no-op
   */
  killWindow(_windowId: string): void {
    // Not supported
  }

  /**
   * Not supported - always returns false
   */
  isWindowAlive(_windowId: string): boolean {
    return false;
  }
}
