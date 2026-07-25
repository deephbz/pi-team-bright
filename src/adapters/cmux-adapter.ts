/**
 * CMUX Terminal Adapter
 * 
 * Implements the TerminalAdapter interface for CMUX (cmux.dev).
 *
 * Spawn strategy: cmux's `new-split` does not support a `--command` flag.
 * We follow the proven pattern from pi-cmux (npm:pi-cmux):
 *   1. Snapshot existing surfaces
 *   2. `cmux new-split <direction>`
 *   3. Poll `cmux list-pane-surfaces` to find the newly created surface
 *   4. `cmux respawn-pane --surface <id> --command <cmd>` to run the command
 */

import { TerminalAdapter, SpawnOptions, execCommand, shellCommand, validateLegacyCommand } from "../utils/terminal-adapter";

const SURFACE_POLL_ATTEMPTS = 20;
const SURFACE_POLL_DELAY_MS = 150;

export class CmuxAdapter implements TerminalAdapter {
  readonly name = "cmux";

  isDirectCarrier(): boolean {
    return true;
  }

  detect(): boolean {
    // Defensive: Don't detect cmux if we're inside tmux or Zellij
    // This prevents false positives in nested terminal scenarios
    if (process.env.TMUX || process.env.ZELLIJ) {
      return false;
    }
    return !!process.env.CMUX_SOCKET_PATH || !!process.env.CMUX_WORKSPACE_ID;
  }

  /**
   * List all surface refs currently visible in the workspace.
   */
  private listSurfaceRefs(): Set<string> {
    const refs = new Set<string>();
    try {
      const result = execCommand("cmux", ["list-pane-surfaces"]);
      if (result.status === 0) {
        for (const line of result.stdout.split("\n")) {
          // Output lines look like: "* surface:5  ⠹ π · ziahmco  [selected]"
          // Extract the surface:N ref from each line.
          const match = line.match(/\b(surface:\d+)\b/);
          if (match) refs.add(match[1]);
        }
      }
    } catch {
      // Ignore
    }
    return refs;
  }

  /**
   * Block until a new surface appears that was not in `before`, or give up.
   */
  private waitForNewSurface(before: Set<string>): string | null {
    for (let i = 0; i < SURFACE_POLL_ATTEMPTS; i++) {
      const current = this.listSurfaceRefs();
      for (const ref of current) {
        if (!before.has(ref)) return ref;
      }
      // spawnSync-based sleep — keeps the adapter synchronous
      execCommand("sleep", [String(SURFACE_POLL_DELAY_MS / 1000)]);
    }
    return null;
  }

  spawn(options: SpawnOptions): string {
    const fullCommand = shellCommand(options);

    // 1. Snapshot existing surfaces before the split
    const before = this.listSurfaceRefs();

    // 2. Create the split (without --command, which is not supported)
    const splitResult = execCommand("cmux", ["new-split", "right"]);

    if (splitResult.status !== 0) {
      throw new Error(`cmux new-split failed with status ${splitResult.status}: ${splitResult.stderr}`);
    }

    // 3. Poll for the newly created surface
    const newSurface = this.waitForNewSurface(before);
    if (!newSurface) {
      throw new Error("cmux new-split succeeded but new surface was not found");
    }

    // 4. Use respawn-pane to run the command in the new surface
    const respawnResult = execCommand("cmux", [
      "respawn-pane",
      "--surface", newSurface,
      "--command", fullCommand,
    ]);

    if (respawnResult.status !== 0) {
      throw new Error(`cmux respawn-pane failed with status ${respawnResult.status}: ${respawnResult.stderr}`);
    }

    return newSurface;
  }

  kill(paneId: string): void {
    if (!paneId) return;
    
    try {
      // CMUX calls them surfaces
      execCommand("cmux", ["close-surface", "--surface", paneId]);
    } catch {
      // Ignore errors during kill
    }
  }

  isAlive(paneId: string): boolean {
    if (!paneId) return false;

    try {
      // We can use list-pane-surfaces and grep for the ID
      // Or just 'identify' if we want to be precise, but list-pane-surfaces is safer
      const result = execCommand("cmux", ["list-pane-surfaces"]);
      return result.stdout.includes(paneId);
    } catch {
      return false;
    }
  }

  setTitle(title: string): void {
    try {
      // rename-tab or rename-workspace? 
      // Usually agents want to rename their current "tab" or "surface"
      execCommand("cmux", ["rename-tab", title]);
    } catch {
      // Ignore errors
    }
  }

  /**
   * CMUX supports spawning separate OS windows
   */
  supportsWindows(): boolean {
    return true;
  }

  /**
   * Spawn a new separate OS window.
   */
  spawnWindow(options: SpawnOptions): string {
    // CMUX new-window returns "OK <UUID>"
    const result = execCommand("cmux", ["new-window"]);
    
    if (result.status !== 0) {
      throw new Error(`cmux new-window failed with status ${result.status}: ${result.stderr}`);
    }

    const output = result.stdout.trim();
    if (output.startsWith("OK ")) {
      const windowId = output.substring(3).trim();
      
      // Now we need to run the command in this window.
      // Usually new-window creates a default workspace/surface.
      // We might need to find the workspace in that window.
      
      // For now, let's just use 'new-workspace' in that window if possible, 
      // but CMUX commands usually target the current window unless specified.
      // Wait a bit for the window to be ready?
      
      const fullCommand = shellCommand(options);

      // Target the new window
      execCommand("cmux", ["new-workspace", "--window", windowId, "--command", fullCommand]);

      if (options.teamName) {
        this.setWindowTitle(windowId, options.teamName);
      }

      return windowId;
    }

    throw new Error(`cmux new-window returned unexpected output: ${output}`);
  }

  /**
   * Set the title of a specific window.
   */
  setWindowTitle(windowId: string, title: string): void {
    try {
      execCommand("cmux", ["rename-window", "--window", windowId, title]);
    } catch {
      // Ignore
    }
  }

  /**
   * Kill/terminate a window.
   */
  killWindow(windowId: string): void {
    if (!windowId) return;
    try {
      execCommand("cmux", ["close-window", "--window", windowId]);
    } catch {
      // Ignore
    }
  }

  /**
   * Check if a window is still alive.
   */
  isWindowAlive(windowId: string): boolean {
    if (!windowId) return false;
    try {
      const result = execCommand("cmux", ["list-windows"]);
      return result.stdout.includes(windowId);
    } catch {
      return false;
    }
  }

  /**
   * Custom CMUX capability: create a workspace for a problem.
   * This isn't part of the TerminalAdapter interface but can be used via the adapter.
   */
  createProblemWorkspace(title: string, command?: string): string {
    const args = ["new-workspace"];
    if (command) {
      args.push("--command", validateLegacyCommand(command));
    }
    
    const result = execCommand("cmux", args);
    if (result.status !== 0) {
      throw new Error(`cmux new-workspace failed: ${result.stderr}`);
    }
    
    const output = result.stdout.trim();
    if (output.startsWith("OK ")) {
      const workspaceId = output.substring(3).trim();
      execCommand("cmux", ["workspace-action", "--action", "rename", "--title", title, "--workspace", workspaceId]);
      return workspaceId;
    }
    
    throw new Error(`cmux new-workspace returned unexpected output: ${output}`);
  }
}
