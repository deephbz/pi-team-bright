import {
  TerminalAdapter,
  SpawnOptions,
  execCommand,
  spawnArgv,
  validateSpawnOptions,
} from "../utils/terminal-adapter";

type HerdrEnvelope = {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

const FORWARDED_ENV = /^(?:PI_[A-Z0-9_]+|HTTP_PROXY|HTTPS_PROXY|WSS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|wss_proxy|all_proxy|no_proxy)$/;

function currentHerdrPane(): string | null {
  const paneId = process.env.HERDR_PANE_ID?.trim();
  return paneId || null;
}

function currentHerdrTab(): string | null {
  const tabId = process.env.HERDR_TAB_ID?.trim();
  return tabId || null;
}

function errorText(error: HerdrEnvelope["error"]): string {
  const code = typeof error?.code === "string" ? error.code : "unknown_error";
  const message = typeof error?.message === "string" ? error.message : "Herdr returned an invalid error response";
  return `${code}: ${message}`;
}

function parseEnvelope(stdout: string): HerdrEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Herdr returned malformed JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Herdr returned an invalid JSON envelope.");
  }
  return parsed as HerdrEnvelope;
}

function resultRecord(envelope: HerdrEnvelope): Record<string, unknown> {
  if (envelope.error) throw new Error(`Herdr request failed: ${errorText(envelope.error)}`);
  const result = envelope.result ?? envelope;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Herdr returned a response without an object result.");
  }
  return result as Record<string, unknown>;
}

function isPaneNotFound(error: unknown): boolean {
  return error instanceof Error && /(?:^|\W)pane_not_found(?:\W|$)/.test(error.message);
}

/** Herdr owns the `pi` executable for its named Pi agent kind; it receives only Pi CLI arguments. */
function piAgentArgs(argv: string[]): string[] {
  if (argv[0] === "node" && argv[1]) return argv.slice(2);
  return argv.slice(1);
}

/** Herdr terminal-surface implementation; it never shells a teammate argv. */
export class HerdrAdapter implements TerminalAdapter {
  readonly name = "herdr";

  currentTargetId(): string | null {
    return currentHerdrPane();
  }

  /**
   * Herdr identity may be inherited by an inner tmux server. That preserves
   * surface discovery but does not make tmux a valid carrier for a Herdr Team.
   */
  isDirectCarrier(): boolean {
    return !process.env.TMUX && !process.env.TMUX_PANE;
  }

  detect(): boolean {
    if (process.env.HERDR_ENV !== "1" || !currentHerdrPane() || !currentHerdrTab()) return false;
    try {
      return execCommand("herdr", ["status", "server"]).status === 0;
    } catch {
      return false;
    }
  }

  private invoke(args: string[]): Record<string, unknown> {
    const response = execCommand("herdr", args);
    let envelope: HerdrEnvelope;
    try {
      envelope = parseEnvelope(response.stdout);
    } catch (error) {
      if (response.status !== 0) {
        throw new Error(`Herdr command failed with status ${response.status}: ${response.stderr || (error instanceof Error ? error.message : String(error))}`);
      }
      throw error;
    }
    if (envelope.error) throw new Error(`Herdr request failed: ${errorText(envelope.error)}`);
    if (response.status !== 0) {
      throw new Error(`Herdr command failed with status ${response.status}: ${response.stderr || "unknown error"}`);
    }
    return resultRecord(envelope);
  }

  spawn(options: SpawnOptions): string {
    if (!options.argv) throw new Error("Herdr spawn requires structured argv; legacy command strings are unsupported.");
    validateSpawnOptions(options);

    const envArgs = Object.entries(options.env)
      .filter(([key, value]) => FORWARDED_ENV.test(key) && !value.includes("\0"))
      .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const argv = spawnArgv(options);
    const split = this.invoke([
      "pane", "split", "--current", "--direction", "right",
      "--cwd", options.cwd,
      ...envArgs,
      "--no-focus",
    ]);
    const pane = split.pane;
    const paneId = pane && typeof pane === "object" && !Array.isArray(pane)
      ? (pane as Record<string, unknown>).pane_id
      : undefined;
    if (typeof paneId !== "string" || !paneId) {
      throw new Error("Herdr pane split response did not include pane.pane_id.");
    }

    try {
      this.invoke([
        "agent", "start", options.name,
        "--kind", "pi",
        "--pane", paneId,
        "--",
        ...piAgentArgs(argv),
      ]);
    } catch (error) {
      try {
        this.invoke(["pane", "close", paneId]);
      } catch {
        // The primary agent-start failure remains the actionable error.
      }
      throw error;
    }
    return paneId;
  }

  kill(paneId: string): void {
    if (!paneId) return;
    try {
      const target = this.invoke(["pane", "get", paneId]).pane;
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        throw new Error("Herdr pane get response did not include the requested pane.");
      }
      const workspaceId = (target as Record<string, unknown>).workspace_id;
      if (typeof workspaceId !== "string" || !workspaceId) {
        throw new Error("Herdr pane get response did not include workspace_id.");
      }
      const listed = this.invoke(["pane", "list", "--workspace", workspaceId]).panes;
      if (!Array.isArray(listed) || !listed.every(pane => pane && typeof pane === "object" && !Array.isArray(pane))) {
        throw new Error("Herdr pane list response did not include panes.");
      }
      if (listed.length <= 1) {
        throw new Error(`Refusing to close Herdr pane ${paneId}: it is the last pane in workspace ${workspaceId}, and close would delete the workspace.`);
      }
      this.invoke(["pane", "close", paneId]);
    } catch (error) {
      if (!isPaneNotFound(error)) throw error;
    }
  }

  isAlive(paneId: string): boolean {
    if (!paneId) return false;
    try {
      const result = this.invoke(["pane", "get", paneId]);
      const pane = result.pane;
      if (!pane || typeof pane !== "object" || Array.isArray(pane)
        || (pane as Record<string, unknown>).pane_id !== paneId) {
        throw new Error("Herdr pane get response did not include the requested pane.");
      }
      const processResult = this.invoke(["pane", "process-info", "--pane", paneId]);
      const processInfo = processResult.process_info;
      if (!processInfo || typeof processInfo !== "object" || Array.isArray(processInfo)
        || (processInfo as Record<string, unknown>).pane_id !== paneId) {
        throw new Error("Herdr pane process-info response did not include the requested pane.");
      }
      const shellPid = (processInfo as Record<string, unknown>).shell_pid;
      return typeof shellPid === "number" && Number.isInteger(shellPid) && shellPid > 0;
    } catch (error) {
      if (isPaneNotFound(error)) return false;
      throw error;
    }
  }

  setTitle(title: string): void {
    const paneId = currentHerdrPane();
    if (!paneId) return;
    try {
      this.invoke(["pane", "rename", paneId, title]);
    } catch {
      // Title presentation must not disrupt the teammate process.
    }
  }

  supportsWindows(): boolean {
    return false;
  }

  spawnWindow(_options: SpawnOptions): string {
    throw new Error("Herdr does not support spawning separate OS windows.");
  }

  setWindowTitle(_windowId: string, _title: string): void {
    // Herdr Teams stay within one originating tab.
  }

  killWindow(_windowId: string): void {
    // Herdr Teams stay within one originating tab.
  }

  isWindowAlive(_windowId: string): boolean {
    return false;
  }
}
