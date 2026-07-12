/**
 * Terminal Adapter Interface
 * 
 * Abstracts terminal multiplexer operations (tmux, iTerm2, Zellij)
 * to provide a unified API for spawning, managing, and terminating panes.
 */

import { spawnSync } from "node:child_process";

/**
 * Options for spawning a new terminal pane or window
 */
export interface SpawnOptions {
  /** Name/identifier for the pane/window */
  name: string;
  /** Working directory for the new pane/window */
  cwd: string;
  /** Structured executable and arguments to execute in the pane/window. */
  argv?: readonly string[];
  /** Legacy static command string retained for older adapter consumers. */
  command?: string;
  /** Environment variables to set (key-value pairs) */
  env: Record<string, string>;
  /** Team name for window title formatting (e.g., "team: agent") */
  teamName?: string;
  /** Optional pane ID to anchor pane-based layouts to a specific origin pane */
  anchorPaneId?: string;
}

/**
 * Terminal Adapter Interface
 * 
 * Implementations provide terminal-specific logic for pane management.
 */
export interface TerminalAdapter {
  /** Unique name identifier for this terminal type */
  readonly name: string;

  /**
   * Detect if this terminal is currently available/active.
   * Should check for terminal-specific environment variables or processes.
   * 
   * @returns true if this terminal should be used
   */
  detect(): boolean;

  /**
   * Spawn a new terminal pane with the given options.
   * 
   * @param options - Spawn configuration
   * @returns Pane ID that can be used for subsequent operations
   * @throws Error if spawn fails
   */
  spawn(options: SpawnOptions): string;

  /**
   * Kill/terminate a terminal pane.
   * Should be idempotent - no error if pane doesn't exist.
   * 
   * @param paneId - The pane ID returned from spawn()
   */
  kill(paneId: string): void;

  /**
   * Check if a terminal pane is still alive/active.
   * 
   * @param paneId - The pane ID returned from spawn()
   * @returns true if pane exists and is active
   */
  isAlive(paneId: string): boolean;

  /**
   * Set the title of the current terminal pane/window.
   * Used for identifying panes in the terminal UI.
   * 
   * @param title - The title to set
   */
  setTitle(title: string): void;

  /**
   * Check if this terminal supports spawning separate OS windows.
   * Terminals like tmux and Zellij only support panes/tabs within a session.
   * 
   * @returns true if spawnWindow() is supported
   */
  supportsWindows(): boolean;

  /**
   * Spawn a new separate OS window with the given options.
   * Only available if supportsWindows() returns true.
   * 
   * @param options - Spawn configuration
   * @returns Window ID that can be used for subsequent operations
   * @throws Error if spawn fails or not supported
   */
  spawnWindow(options: SpawnOptions): string;

  /**
   * Set the title of a specific window.
   * Used for identifying windows in the OS window manager.
   * 
   * @param windowId - The window ID returned from spawnWindow()
   * @param title - The title to set
   */
  setWindowTitle(windowId: string, title: string): void;

  /**
   * Kill/terminate a window.
   * Should be idempotent - no error if window doesn't exist.
   * 
   * @param windowId - The window ID returned from spawnWindow()
   */
  killWindow(windowId: string): void;

  /**
   * Check if a window is still alive/active.
   * 
   * @param windowId - The window ID returned from spawnWindow()
   * @returns true if window exists and is active
   */
  isWindowAlive(windowId: string): boolean;
}

/**
 * Base helper for adapters to execute commands synchronously.
 */
export function execCommand(command: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    status: result.status,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

export function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validatedEnv(options: SpawnOptions): Array<[string, string]> {
  return Object.entries(options.env)
    .filter(([key]) => key.startsWith("PI_"))
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      return [key, value] as [string, string];
    });
}

export function spawnArgv(options: SpawnOptions): string[] {
  if (options.argv && options.command) throw new Error("SpawnOptions must use argv or command, not both.");
  if (options.argv) {
    if (options.argv.length === 0 || options.argv.some(value => typeof value !== "string" || value.includes("\0"))) {
      throw new Error("Spawn argv must contain a non-empty executable and NUL-free strings.");
    }
    return [...options.argv];
  }
  return [validateLegacyCommand(options.command)];
}

export function validateLegacyCommand(command: string | undefined): string {
  if (!command || /[\0\r\n;&|`$()<>{}]/.test(command)) {
    throw new Error("Legacy spawn command contains unsupported shell syntax; use argv instead.");
  }
  return command;
}

export function validateSpawnOptions(options: SpawnOptions): void {
  if (!options.cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(options.cwd)) {
    throw new Error(`Spawn cwd must be absolute: ${options.cwd}`);
  }
  validatedEnv(options);
  spawnArgv(options);
}

export function shellCommand(options: SpawnOptions): string {
  validateSpawnOptions(options);
  const command = options.argv ? options.argv.map(shellQuote).join(" ") : options.command!;
  const env = validatedEnv(options).map(([key, value]) => options.argv ? shellQuote(`${key}=${value}`) : `${key}=${value}`);
  return env.length > 0 ? `env ${env.join(" ")} ${command}` : command;
}

export function powershellCommand(options: SpawnOptions): string {
  validateSpawnOptions(options);
  const env = validatedEnv(options)
    .map(([key, value]) => `$env:${key} = ${powershellQuote(value)}`)
    .join("; ");
  const argv = options.argv ? `& ${options.argv.map(powershellQuote).join(" ")}` : options.command!;
  return `${env ? `${env}; ` : ""}Set-Location -LiteralPath ${powershellQuote(options.cwd)}; ${argv}`;
}
