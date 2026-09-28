import {
  TerminalAdapter,
  SpawnOptions,
  execCommand,
  spawnArgv,
  validateSpawnOptions,
} from "../utils/terminal-adapter";
import { createHash } from "node:crypto";
import {
  DEFAULT_COLUMNS_PER_ROW,
  DEFAULT_TEAM_PANE_LAYOUT,
  MIN_WORKER_PANE_HEIGHT,
  MIN_WORKER_PANE_WIDTH,
  type TeamPaneLayout,
} from "../utils/team-pane-layout";
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

interface PaneRect { x: number; y: number; width: number; height: number; }

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

  renamePane(paneId: string, label: string): void {
    this.invoke(["pane", "rename", paneId, label]);
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

  private paneLayout(leaderPaneId: string): { record: Record<string, unknown>; panes: Record<string, unknown>[] } {
    const layout = this.invoke(["pane", "layout", "--pane", leaderPaneId]).layout;
    if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
      throw new Error(`Herdr leader pane ${leaderPaneId} returned no layout; refusing Worker spawn.`);
    }
    const record = layout as Record<string, unknown>;
    if (!Array.isArray(record.panes)) {
      throw new Error(`Herdr leader pane ${leaderPaneId} layout has no usable panes; refusing Worker spawn.`);
    }
    const panes = record.panes.filter((pane): pane is Record<string, unknown> =>
      !!pane && typeof pane === "object" && !Array.isArray(pane),
    );
    return { record, panes };
  }

  private rectFor(panes: Record<string, unknown>[], paneId: string, requireComplete = false): PaneRect | undefined {
    const pane = panes.find((candidate) => candidate.pane_id === paneId);
    const rect = pane?.rect;
    if (!rect || typeof rect !== "object" || Array.isArray(rect)) {
      if (requireComplete) throw new Error(`Herdr pane ${paneId} has no usable integer geometry; refusing Worker spawn.`);
      return undefined;
    }
    const { x, y, width, height } = rect as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number"
      || ![x, y, width, height].every(Number.isInteger) || width <= 0 || height <= 0) {
      if (requireComplete) throw new Error(`Herdr pane ${paneId} has incomplete integer geometry; refusing Worker spawn.`);
      return undefined;
    }
    return { x, y, width, height };
  }

  private assertWorkerRegion(leaderPaneId: string, workerPaneId: string): void {
    const leader = this.paneRecord(leaderPaneId);
    const worker = this.paneRecord(workerPaneId);
    if (leader.tab_id !== worker.tab_id || leader.workspace_id !== worker.workspace_id) {
      throw new Error(`Herdr Team Worker pane ${workerPaneId} is not in the leader tab; refusing to split it.`);
    }
    const { record, panes } = this.paneLayout(leaderPaneId);
    if (record.tab_id !== leader.tab_id || record.workspace_id !== leader.workspace_id) {
      throw new Error(`Herdr leader pane ${leaderPaneId} layout does not prove its exact tab; refusing Worker spawn.`);
    }
    const horizontalRect = (paneId: string): { x: number; width: number } | undefined => {
      const pane = panes.find((candidate) => candidate.pane_id === paneId);
      const rect = pane?.rect;
      if (!rect || typeof rect !== "object" || Array.isArray(rect)) return undefined;
      const { x, width } = rect as Record<string, unknown>;
      return typeof x === "number" && typeof width === "number" && Number.isInteger(x) && Number.isInteger(width)
        ? { x, width } : undefined;
    };
    const leaderRect = horizontalRect(leaderPaneId);
    const workerRect = horizontalRect(workerPaneId);
    if (!leaderRect || !workerRect || workerRect.x < leaderRect.x + leaderRect.width) {
      throw new Error(`Herdr Team Worker pane ${workerPaneId} is outside the leader Worker region; refusing to split it.`);
    }
  }

  private firstWorkerLeaderShare(
    leaderPaneId: string,
    leaderShare: number,
    enforceMinimum = false,
    leaderIdentity?: Record<string, unknown>,
  ): string {
    const leader = enforceMinimum ? leaderIdentity : undefined;
    if (leader && (typeof leader.tab_id !== "string" || !leader.tab_id || typeof leader.workspace_id !== "string" || !leader.workspace_id)) {
      throw new Error(`Herdr leader pane ${leaderPaneId} has no exact tab or workspace identity; refusing Worker spawn.`);
    }
    const { record, panes } = this.paneLayout(leaderPaneId);
    if (leader && (record.tab_id !== leader.tab_id || record.workspace_id !== leader.workspace_id)) {
      throw new Error(`Herdr leader pane ${leaderPaneId} layout does not prove its exact tab; refusing Worker spawn.`);
    }
    const rect = enforceMinimum ? this.rectFor(panes, leaderPaneId, true) : undefined;
    const width = rect?.width ?? (() => {
      const pane = panes.find((candidate) => candidate.pane_id === leaderPaneId);
      const candidateWidth = pane?.rect && typeof pane.rect === "object" && !Array.isArray(pane.rect)
        ? (pane.rect as Record<string, unknown>).width : undefined;
      if (typeof candidateWidth !== "number" || !Number.isInteger(candidateWidth) || candidateWidth <= 0) {
        throw new Error(`Herdr leader pane ${leaderPaneId} layout has no usable width; refusing Worker spawn.`);
      }
      return candidateWidth;
    })();
    // Herdr rounds the existing pane down. Round the requested share up so its
    // rendered integer width is never below the Team's configured invariant.
    const requestedLeaderWidth = Math.ceil(width * leaderShare);
    const workerWidth = width - requestedLeaderWidth;
    if (requestedLeaderWidth >= width) {
      throw new Error(`Herdr leader pane ${leaderPaneId} is too narrow to represent leader_share=${leaderShare} while leaving a Worker region.`);
    }
    if (enforceMinimum && (requestedLeaderWidth < MIN_WORKER_PANE_WIDTH || workerWidth < MIN_WORKER_PANE_WIDTH
      || rect!.height < MIN_WORKER_PANE_HEIGHT)) {
      throw new Error(`Herdr pane geometry is insufficient for the first Worker: leader and Worker panes require at least ${MIN_WORKER_PANE_WIDTH}x${MIN_WORKER_PANE_HEIGHT}.`);
    }
    return String(requestedLeaderWidth / width);
  }

  /** Choose the largest viable registered Worker pane from the live Herdr layout. */
  private adaptiveSplit(leaderPaneId: string, workerPaneIds: readonly string[], columnsPerRow: number): { targetPaneId: string; direction: "right" | "down" } {
    const leader = this.paneRecord(leaderPaneId);
    if (typeof leader.tab_id !== "string" || !leader.tab_id || typeof leader.workspace_id !== "string" || !leader.workspace_id) {
      throw new Error(`Herdr leader pane ${leaderPaneId} has no exact tab or workspace identity; refusing Worker spawn.`);
    }
    const registered = workerPaneIds.flatMap((paneId) => {
      try {
        return [{ paneId, pane: this.paneRecord(paneId) }];
      } catch (error) {
        if (isPaneNotFound(error)) return [];
        throw error;
      }
    });
    // Membership registration supplies the candidate set. A moved or otherwise
    // unusable candidate is ignored; a valid registered candidate can still be
    // selected without falling back to an ambient pane.
    const eligibleRegistered = registered.filter(({ pane }) =>
      leader.tab_id === pane.tab_id && leader.workspace_id === pane.workspace_id,
    );
    const { record, panes } = this.paneLayout(leaderPaneId);
    if (record.tab_id !== leader.tab_id || record.workspace_id !== leader.workspace_id) {
      throw new Error(`Herdr leader pane ${leaderPaneId} layout does not prove its exact tab; refusing Worker spawn.`);
    }
    const leaderRect = this.rectFor(panes, leaderPaneId, true);
    if (!leaderRect) throw new Error(`Herdr leader pane ${leaderPaneId} has no usable geometry; refusing Worker spawn.`);
    const candidates: Array<{ paneId: string; score: number; direction: "right" | "down" }> = [];
    for (const { paneId } of eligibleRegistered) {
      const rect = this.rectFor(panes, paneId);
      if (!rect || rect.x < leaderRect.x + leaderRect.width
        || rect.y < leaderRect.y || rect.y + rect.height > leaderRect.y + leaderRect.height) continue;
      const horizontal = rect.width / columnsPerRow >= rect.height;
      const splitSize = horizontal ? rect.width : rect.height;
      const firstChild = Math.floor(splitSize / 2);
      const secondChild = splitSize - firstChild;
      const childWidth = horizontal ? firstChild : rect.width;
      const childHeight = horizontal ? rect.height : firstChild;
      const secondChildWidth = horizontal ? secondChild : rect.width;
      const secondChildHeight = horizontal ? rect.height : secondChild;
      if (childWidth < MIN_WORKER_PANE_WIDTH || secondChildWidth < MIN_WORKER_PANE_WIDTH
        || childHeight < MIN_WORKER_PANE_HEIGHT || secondChildHeight < MIN_WORKER_PANE_HEIGHT) continue;
      candidates.push({
        paneId,
        score: Math.max(rect.width / columnsPerRow, rect.height),
        direction: horizontal ? "right" : "down",
      });
    }
    candidates.sort((a, b) => b.score - a.score || (a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0));
    const selected = candidates[0];
    if (!selected) {
      throw new Error(`Insufficient Herdr pane geometry for another Worker: every registered Worker pane would create a child below ${MIN_WORKER_PANE_WIDTH}x${MIN_WORKER_PANE_HEIGHT}.`);
    }
    return { targetPaneId: selected.paneId, direction: selected.direction };
  }

  spawn(options: SpawnOptions): string {
    if (!options.argv) throw new Error("Herdr spawn requires structured argv; legacy command strings are unsupported.");
    if (!options.panePlacement) throw new Error("Herdr Worker spawn requires exact Team pane placement.");
    validateSpawnOptions(options);

    const { leaderPaneId, workerPaneIds } = options.panePlacement;
    const paneLayout: TeamPaneLayout = options.panePlacement.paneLayout ?? DEFAULT_TEAM_PANE_LAYOUT;
    // `grid` remains a read-compatible alias for live adaptive placement.
    const adaptive = paneLayout.worker_tiling === "adaptive" || paneLayout.worker_tiling === "grid";
    const workerCount = workerPaneIds.length;
    if (paneLayout.worker_limit !== undefined && workerCount >= paneLayout.worker_limit) {
      throw new Error(`Herdr Worker limit ${paneLayout.worker_limit} has been reached; refusing another Worker pane.`);
    }
    if (!workerPaneIds.every((paneId) => !!paneId && paneId !== leaderPaneId)
      || new Set(workerPaneIds).size !== workerPaneIds.length) {
      throw new Error("Herdr Worker spawn requires distinct exact Team pane targets.");
    }
    let adaptiveTarget: { targetPaneId: string; direction: "right" | "down" } | undefined;
    if (workerCount > 0 && adaptive) {
      adaptiveTarget = this.adaptiveSplit(leaderPaneId, workerPaneIds, paneLayout.columns_per_row ?? DEFAULT_COLUMNS_PER_ROW);
    }
    const targetPaneId = workerCount === 0 ? leaderPaneId : adaptiveTarget?.targetPaneId ?? workerPaneIds.at(-1)!;
    const direction = workerCount === 0 ? "right" : adaptiveTarget?.direction ?? "down";
    const firstWorkerLeaderShare = workerCount === 0
      ? (() => {
        const leaderRecord = this.paneRecord(targetPaneId);
        return this.firstWorkerLeaderShare(leaderPaneId, paneLayout.leader_share, adaptive, leaderRecord);
      })()
      : undefined;
    if (workerCount > 0 && !adaptive) this.assertWorkerRegion(leaderPaneId, targetPaneId);

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
        this.renamePane(paneId, options.name);
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
