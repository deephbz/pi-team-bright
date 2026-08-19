import {
  TerminalAdapter,
  SpawnOptions,
  execCommand,
  spawnArgv,
  validateSpawnOptions,
} from "../utils/terminal-adapter";
import { createHash } from "node:crypto";
import { DEFAULT_TEAM_PANE_LAYOUT, type TeamPaneLayout } from "../utils/team-pane-layout";
import { recordWorkerLaunchStage } from "../utils/trace";

type HerdrEnvelope = {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

const FORWARDED_ENV = /^(?:PI_[A-Z0-9_]+|HTTP_PROXY|HTTPS_PROXY|WSS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|wss_proxy|all_proxy|no_proxy)$/;
const SHELL_READY_RETRY_MS = 50;
const SHELL_READY_TIMEOUT_MS = 5_000;
/** Official Herdr agent-start readiness bound in milliseconds. */
const AGENT_READY_TIMEOUT_MS = 6_000;
/** Herdr applies a right-split ratio to the existing (leader) pane. */
const retryWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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

function isAgentPaneBusy(error: unknown): boolean {
  return error instanceof Error && /(?:^|\W)agent_pane_busy(?:\W|$)/.test(error.message);
}

function managedPiArgv(response: Record<string, unknown>): void {
  const argv = response.argv;
  if (!Array.isArray(argv) || argv.length < 1 || argv[0] !== "pi" || argv.some((value) => typeof value !== "string")) {
    throw new Error("Herdr agent_started response did not include canonical Pi argv.");
  }
}

/** Validate the official managed-start response and its exact ready target. */
function assertReadyStart(response: Record<string, unknown>, carrierName: string, paneId: string): void {
  if (response.type !== "agent_started") throw new Error("Herdr start response did not identify agent_started.");
  managedPiArgv(response);
  const agent = response.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new Error("Herdr start response did not include an agent record.");
  }
  const record = agent as Record<string, unknown>;
  if (record.name !== carrierName || record.pane_id !== paneId || typeof record.terminal_id !== "string" || !record.terminal_id) {
    throw new Error(`Herdr start did not prove exact managed target ${carrierName} in pane ${paneId}.`);
  }
  if (record.agent !== "pi" || record.interactive_ready !== true) {
    throw new Error(`Herdr start did not prove interactive recognized Pi agent ${carrierName}.`);
  }
}

/** Herdr names are lowercase identifiers with a fixed 32-character limit. */
export function herdrCarrierName(teamName: string | undefined, workerName: string): string {
  const source = teamName?.trim() ? `${teamName.trim()}-${workerName}` : workerName;
  if (/^[a-z][a-z0-9_-]{0,31}$/.test(source)) return source;
  const normalized = source.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const prefixed = /^[a-z]/.test(normalized) ? normalized : `agent-${normalized}`;
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 8);
  const prefix = (prefixed.slice(0, 23) || "agent").padEnd(1, "a");
  return `${prefix}-${digest}`;
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

  private paneRecord(paneId: string): Record<string, unknown> {
    const pane = this.invoke(["pane", "get", paneId]).pane;
    if (!pane || typeof pane !== "object" || Array.isArray(pane)
      || (pane as Record<string, unknown>).pane_id !== paneId) {
      throw new Error(`Herdr pane ${paneId} is not an exact usable target.`);
    }
    return pane as Record<string, unknown>;
  }

  private assertWorkerRegion(leaderPaneId: string, workerPaneId: string): void {
    const leader = this.paneRecord(leaderPaneId);
    const worker = this.paneRecord(workerPaneId);
    if (leader.tab_id !== worker.tab_id || leader.workspace_id !== worker.workspace_id) {
      throw new Error(`Herdr Team Worker pane ${workerPaneId} is not in the leader tab; refusing to split it.`);
    }
    const layout = this.invoke(["pane", "layout", "--pane", leaderPaneId]).layout;
    if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
      throw new Error(`Herdr leader pane ${leaderPaneId} returned no layout; refusing Worker spawn.`);
    }
    const record = layout as Record<string, unknown>;
    const panes = record.panes;
    if (record.tab_id !== leader.tab_id || record.workspace_id !== leader.workspace_id || !Array.isArray(panes)) {
      throw new Error(`Herdr leader pane ${leaderPaneId} layout does not prove its exact tab; refusing Worker spawn.`);
    }
    const rectFor = (paneId: string) => {
      const pane = panes.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).pane_id === paneId) as Record<string, unknown> | undefined;
      const rect = pane?.rect;
      if (!rect || typeof rect !== "object" || Array.isArray(rect)) return undefined;
      const { x, width } = rect as Record<string, unknown>;
      return typeof x === "number" && typeof width === "number" ? { x, width } : undefined;
    };
    const leaderRect = rectFor(leaderPaneId);
    const workerRect = rectFor(workerPaneId);
    if (!leaderRect || !workerRect || workerRect.x < leaderRect.x + leaderRect.width) {
      throw new Error(`Herdr Team Worker pane ${workerPaneId} is outside the leader Worker region; refusing to split it.`);
    }
  }

  private firstWorkerLeaderShare(leaderPaneId: string, leaderShare: number): string {
    const layout = this.invoke(["pane", "layout", "--pane", leaderPaneId]).layout;
    if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
      throw new Error(`Herdr leader pane ${leaderPaneId} returned no layout; refusing Worker spawn.`);
    }
    const panes = (layout as Record<string, unknown>).panes;
    if (!Array.isArray(panes)) {
      throw new Error(`Herdr leader pane ${leaderPaneId} layout has no panes; refusing Worker spawn.`);
    }
    const leader = panes.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).pane_id === leaderPaneId) as Record<string, unknown> | undefined;
    const rect = leader?.rect;
    const width = rect && typeof rect === "object" && !Array.isArray(rect)
      ? (rect as Record<string, unknown>).width
      : undefined;
    if (typeof width !== "number" || !Number.isInteger(width) || width <= 0) {
      throw new Error(`Herdr leader pane ${leaderPaneId} layout has no usable width; refusing Worker spawn.`);
    }
    // Herdr rounds the existing pane down. Round the requested share up so its
    // rendered integer width is never below the Team's configured invariant.
    const requestedLeaderWidth = Math.ceil(width * leaderShare);
    if (requestedLeaderWidth >= width) {
      throw new Error(`Herdr leader pane ${leaderPaneId} is too narrow to represent leader_share=${leaderShare} while leaving a Worker region.`);
    }
    return String(requestedLeaderWidth / width);
  }

  spawn(options: SpawnOptions): string {
    if (!options.argv) throw new Error("Herdr spawn requires structured argv; legacy command strings are unsupported.");
    if (!options.panePlacement) throw new Error("Herdr Worker spawn requires exact Team pane placement.");
    validateSpawnOptions(options);

    const { leaderPaneId, workerPaneIds } = options.panePlacement;
    const paneLayout: TeamPaneLayout = options.panePlacement.paneLayout ?? DEFAULT_TEAM_PANE_LAYOUT;
    const isGrid = paneLayout.worker_tiling === "grid";
    // Grid placement is deliberately explicit. For four Workers, the first
    // split creates the Worker region, the second creates its second row, and
    // the third and fourth split the two rows into stable columns.
    const workerCount = workerPaneIds.length;
    const targetPaneId = workerCount === 0
      ? leaderPaneId
      : isGrid && workerCount >= 2
        ? workerPaneIds[workerCount - 2]
        : workerPaneIds.at(-1)!;
    const direction = workerCount === 0
      ? "right"
      : isGrid && workerCount >= 2
        ? "right"
        : "down";
    if (!targetPaneId || workerPaneIds.some((paneId) => !paneId || paneId === leaderPaneId)) {
      throw new Error("Herdr Worker spawn requires distinct exact Team pane targets.");
    }
    const firstWorkerLeaderShare = workerCount === 0
      ? (this.paneRecord(targetPaneId), this.firstWorkerLeaderShare(leaderPaneId, paneLayout.leader_share))
      : undefined;
    if (workerCount > 0) this.assertWorkerRegion(leaderPaneId, targetPaneId);

    const envArgs = Object.entries(options.env)
      .filter(([key, value]) => FORWARDED_ENV.test(key) && !value.includes("\0"))
      .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const argv = spawnArgv(options);
    const split = this.invoke([
      "pane", "split", "--pane", targetPaneId,
      "--direction", direction,
      "--ratio", workerCount > 0 ? "0.5" : firstWorkerLeaderShare!,
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
      // The split response is the authority for the new pane. Name that exact
      // pane before agent startup so display identity never depends on title
      // inference or mutation inside Herdr's readiness window. Presentation
      // failure must not prevent the Worker from starting.
      try {
        this.invoke(["pane", "rename", paneId, options.name]);
        recordWorkerLaunchStage("carrier_label_applied");
      } catch (error) {
        recordWorkerLaunchStage("carrier_label_not_applied");
        console.warn(`[pi-teams] Herdr Worker pane ${paneId} could not be named: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Herdr agent names are live carrier identity, not stable Worker identity.
      // Qualify them by Team so a reused Worker name cannot collide with a
      // stale or concurrent agent in another Team.
      const carrierName = herdrCarrierName(options.env.PI_TEAM_NAME, options.name);
      const startArgs = [
        "agent", "start", carrierName,
        "--kind", "pi",
        "--pane", paneId,
        "--timeout", String(AGENT_READY_TIMEOUT_MS),
        "--",
        ...piAgentArgs(argv),
      ];
      const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
      while (true) {
        try {
          assertReadyStart(this.invoke(startArgs), carrierName, paneId);
          break;
        } catch (error) {
          if (!isAgentPaneBusy(error) || Date.now() >= deadline) throw error;
          // Pane split can return before the new shell reaches its prompt.
          // Retry only Herdr's explicit transient busy state.
          Atomics.wait(retryWait, 0, 0, SHELL_READY_RETRY_MS);
        }
      }
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

  setTitle(_title: string): void {
    // Herdr owns recognized-agent lifecycle while `agent start` waits for Pi.
    // Do not mutate pane or display metadata from inside that startup window.
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
