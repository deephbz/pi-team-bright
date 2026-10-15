import { hostEnv } from "../env/host-env";
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
import { HerdrRequestError, readHerdrEnvelope, readHerdrReply, herdrResult } from "../utils/herdr-reply";

type HerdrQuery = (args: string[]) => Record<string, unknown>;

const FORWARDED_ENV = /^(?:PI_[A-Z0-9_]+|HTTP_PROXY|HTTPS_PROXY|WSS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|wss_proxy|all_proxy|no_proxy)$/;
const SHELL_READY_RETRY_MS = 50;
const SHELL_READY_TIMEOUT_MS = 5_000;
/** Official Herdr agent-start readiness bound in milliseconds. */
const AGENT_READY_TIMEOUT_MS = 300_000;

interface PaneRect { x: number; y: number; width: number; height: number; }

/** Herdr applies a right-split ratio to the existing (leader) pane. */

function currentHerdrPane(): string | null {
  const paneId = hostEnv().process.env.HERDR_PANE_ID?.trim();
  return paneId || null;
}

function currentHerdrTab(): string | null {
  const tabId = hostEnv().process.env.HERDR_TAB_ID?.trim();
  return tabId || null;
}

function isPaneNotFound(error: unknown): boolean {
  return error instanceof HerdrRequestError && error.code === "pane_not_found";
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
    return !hostEnv().process.env.TMUX && !hostEnv().process.env.TMUX_PANE;
  }

  detect(): boolean {
    if (hostEnv().process.env.HERDR_ENV !== "1" || !currentHerdrPane() || !currentHerdrTab()) return false;
    try {
      return execCommand("herdr", ["status", "server"]).status === 0;
    } catch {
      return false;
    }
  }

  async detectAsync(): Promise<boolean> {
    if (hostEnv().process.env.HERDR_ENV !== "1" || !currentHerdrPane() || !currentHerdrTab()) return false;
    try {
      const result = await hostEnv().exec.run("herdr", ["status", "server"], { timeoutMs: 2000 });
      return result.kind === "exited" && result.status === 0;
    } catch { return false; }
  }

  async renamePaneAsync(paneId: string, label: string): Promise<void> {
    await this.invokeAsync(["pane", "rename", paneId, label]);
  }

  private invoke(args: string[]): Record<string, unknown> {
    return readHerdrReply(execCommand("herdr", args));
  }

  private paneRecord(paneId: string, query: HerdrQuery = this.invoke.bind(this)): Record<string, unknown> {
    const pane = query(["pane", "get", paneId]).pane;
    if (!pane || typeof pane !== "object" || Array.isArray(pane)
      || (pane as Record<string, unknown>).pane_id !== paneId) {
      throw new Error(`Herdr pane ${paneId} is not an exact usable target.`);
    }
    return pane as Record<string, unknown>;
  }

  private paneLayout(leaderPaneId: string, query: HerdrQuery = this.invoke.bind(this)): { record: Record<string, unknown>; panes: Record<string, unknown>[] } {
    const layout = query(["pane", "layout", "--pane", leaderPaneId]).layout;
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

  private assertWorkerRegion(leaderPaneId: string, leader: Record<string, unknown>, workerPaneId: string, worker: Record<string, unknown>, query: HerdrQuery): void {
    if (leader.tab_id !== worker.tab_id || leader.workspace_id !== worker.workspace_id) {
      throw new Error(`Herdr Team Worker pane ${workerPaneId} is not in the leader tab; refusing to split it.`);
    }
    const { record, panes } = this.paneLayout(leaderPaneId, query);
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
    leaderIdentity: Record<string, unknown> | undefined,
    query: HerdrQuery,
  ): string {
    const leader = enforceMinimum ? leaderIdentity : undefined;
    if (leader && (typeof leader.tab_id !== "string" || !leader.tab_id || typeof leader.workspace_id !== "string" || !leader.workspace_id)) {
      throw new Error(`Herdr leader pane ${leaderPaneId} has no exact tab or workspace identity; refusing Worker spawn.`);
    }
    const { record, panes } = this.paneLayout(leaderPaneId, query);
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
  private adaptiveSplit(leaderPaneId: string, leader: Record<string, unknown>, registered: { paneId: string; pane: Record<string, unknown> }[], columnsPerRow: number, query: HerdrQuery): { targetPaneId: string; direction: "right" | "down" } {
    if (typeof leader.tab_id !== "string" || !leader.tab_id || typeof leader.workspace_id !== "string" || !leader.workspace_id) {
      throw new Error(`Herdr leader pane ${leaderPaneId} has no exact tab or workspace identity; refusing Worker spawn.`);
    }
    // Membership registration supplies the candidate set. A moved or otherwise
    // unusable candidate is ignored; a valid registered candidate can still be
    // selected without falling back to an ambient pane.
    const eligibleRegistered = registered.filter(({ pane }) =>
      leader.tab_id === pane.tab_id && leader.workspace_id === pane.workspace_id,
    );
    const { record, panes } = this.paneLayout(leaderPaneId, query);
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
    const paneId = this.prepareSpawn(options);
    void this.startPrepared(paneId, options);
    return paneId;
  }

  /** Create location only. The caller records it before it starts Pi. */
  private splitArgs(options: SpawnOptions, query: HerdrQuery): string[] {
    if (!options.argv) throw new Error("Herdr spawn requires structured argv; legacy command strings are unsupported.");
    if (!options.panePlacement) throw new Error("Herdr Worker spawn requires exact Team pane placement.");
    validateSpawnOptions(options);

    const { leaderPaneId, workerPaneIds } = options.panePlacement;
    const paneLayout: TeamPaneLayout = options.panePlacement.paneLayout ?? DEFAULT_TEAM_PANE_LAYOUT;
    // `grid` remains a read-compatible alias for live adaptive placement.
    const adaptive = paneLayout.worker_tiling === "adaptive" || paneLayout.worker_tiling === "grid";
    // Capacity counts registered Workers even when their panes have closed.
    if (paneLayout.worker_limit !== undefined && workerPaneIds.length >= paneLayout.worker_limit) {
      throw new Error(`Herdr Worker limit ${paneLayout.worker_limit} has been reached; refusing another Worker pane.`);
    }
    if (!workerPaneIds.every((paneId) => !!paneId && paneId !== leaderPaneId)
      || new Set(workerPaneIds).size !== workerPaneIds.length) {
      throw new Error("Herdr Worker spawn requires distinct exact Team pane targets.");
    }
    const leader = this.paneRecord(leaderPaneId, query);
    const presentWorkers = workerPaneIds.flatMap((paneId) => {
      try {
        return [{ paneId, pane: this.paneRecord(paneId, query) }];
      } catch (error) {
        if (isPaneNotFound(error)) return [];
        throw error;
      }
    });
    const workerCount = presentWorkers.length;
    let adaptiveTarget: { targetPaneId: string; direction: "right" | "down" } | undefined;
    if (workerCount > 0 && adaptive) {
      adaptiveTarget = this.adaptiveSplit(leaderPaneId, leader, presentWorkers, paneLayout.columns_per_row ?? DEFAULT_COLUMNS_PER_ROW, query);
    }
    const targetPaneId = workerCount === 0 ? leaderPaneId : adaptiveTarget?.targetPaneId ?? presentWorkers.at(-1)!.paneId;
    const direction = workerCount === 0 ? "right" : adaptiveTarget?.direction ?? "down";
    const firstWorkerLeaderShare = workerCount === 0
      ? this.firstWorkerLeaderShare(leaderPaneId, paneLayout.leader_share, adaptive, leader, query)
      : undefined;
    if (workerCount > 0 && !adaptive) this.assertWorkerRegion(leaderPaneId, leader, targetPaneId, presentWorkers.at(-1)!.pane, query);

    const envArgs = Object.entries(options.env)
      .filter(([key, value]) => FORWARDED_ENV.test(key) && !value.includes("\0"))
      .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    return [
      "pane", "split", "--pane", targetPaneId,
      "--direction", direction,
      "--ratio", workerCount > 0 ? "0.5" : firstWorkerLeaderShare!,
      "--cwd", options.cwd,
      ...envArgs,
      "--no-focus",
    ];
  }

  prepareSpawn(options: SpawnOptions): string {
    const split = this.invoke(this.splitArgs(options, this.invoke.bind(this)));
    const pane = split.pane;
    const paneId = pane && typeof pane === "object" && !Array.isArray(pane)
      ? (pane as Record<string, unknown>).pane_id
      : undefined;
    if (typeof paneId !== "string" || !paneId) {
      throw new Error("Herdr pane split response did not include pane.pane_id.");
    }

    try { this.renamePane(paneId, options.name); } catch (error) {
      console.warn(`[pi-teams] Herdr Worker pane ${paneId} could not be named: ${error instanceof Error ? error.message : String(error)}`);
    }
    return paneId;
  }

  private async invokeAsync(args: string[], deadline = hostEnv().clock.now() + 2000): Promise<Record<string, unknown>> {
    const timeoutMs = Math.min(2000, deadline - hostEnv().clock.now());
    if (timeoutMs <= 0) throw new Error("herdr_preparation_budget_expired");
    const result = await hostEnv().exec.run("herdr", args, { timeoutMs });
    if (result.kind !== "exited") throw new Error(`herdr_${args[1]}_${result.kind}`);
    return readHerdrReply(result);
  }

  /** Snapshot placement asynchronously; geometry uses the same algorithm as legacy callers. */
  async prepareSpawnAsync(options: SpawnOptions, deadline = hostEnv().clock.now() + 9000): Promise<string> {
    if (!options.panePlacement) throw new Error("Herdr Worker spawn requires exact Team pane placement.");
    const { leaderPaneId, workerPaneIds } = options.panePlacement;
    const layoutArgs = ["pane", "layout", "--pane", leaderPaneId];
    const layoutReply = await this.invokeAsync(layoutArgs, deadline);
    const { record, panes } = this.paneLayout(leaderPaneId, () => layoutReply);
    const paneIds = panes.map(pane => pane.pane_id);
    if (typeof record.tab_id !== "string" || !record.tab_id || typeof record.workspace_id !== "string" || !record.workspace_id
      || !paneIds.includes(leaderPaneId) || paneIds.some(id => typeof id !== "string" || !id)
      || new Set(paneIds).size !== paneIds.length) {
      throw new Error(`Herdr leader pane ${leaderPaneId} layout does not prove exact pane identities; refusing Worker spawn.`);
    }
    const snapshot = new Map<string, Record<string, unknown> | Error>([[JSON.stringify(layoutArgs), layoutReply]]);
    // A single layout proves location for its exact member panes. Do not carry
    // this evidence into another operation or infer absence for omitted panes.
    for (const pane of panes) snapshot.set(JSON.stringify(["pane", "get", pane.pane_id]), {
      pane: { ...pane, tab_id: record.tab_id, workspace_id: record.workspace_id },
    });
    await Promise.all(workerPaneIds.filter(id => !paneIds.includes(id)).map(async id => {
      const args = ["pane", "get", id];
      try { snapshot.set(JSON.stringify(args), await this.invokeAsync(args, deadline)); }
      catch (error) { snapshot.set(JSON.stringify(args), error instanceof Error ? error : new Error(String(error))); }
    }));
    const splitArgs = this.splitArgs(options, args => {
      const value = snapshot.get(JSON.stringify(args));
      if (value instanceof Error) throw value;
      if (!value) throw new Error("Herdr placement snapshot is incomplete.");
      return value;
    });
    const split = await this.invokeAsync(splitArgs, deadline);
    const paneId = (split.pane as Record<string, unknown> | undefined)?.pane_id;
    if (typeof paneId !== "string" || !paneId) throw new Error("Herdr pane split response did not include pane.pane_id.");
    // Naming failure cannot discard a created target or authorize another split.
    try { await this.invokeAsync(["pane", "rename", paneId, options.name], deadline); } catch (error) {
      console.warn(`[pi-teams] Herdr Worker pane ${paneId} could not be named: ${error instanceof Error ? error.message : String(error)}`);
    }
    return paneId;
  }

  async startPrepared(paneId: string, options: SpawnOptions): Promise<{ state: "started" | "refused" | "unknown"; fact: string }> {
    const deadline = hostEnv().clock.now() + SHELL_READY_TIMEOUT_MS;
    for (;;) {
      const result = await this.startOnce(paneId, options);
      if (result.state !== "refused" || !result.fact.startsWith("agent_pane_busy:") || hostEnv().clock.now() >= deadline) return result;
      await new Promise<void>(resolve => hostEnv().clock.setTimeout(resolve, SHELL_READY_RETRY_MS));
    }
  }

  private async startOnce(paneId: string, options: SpawnOptions): Promise<{ state: "started" | "refused" | "unknown"; fact: string }> {
    const carrierName = herdrCarrierName(options.env.PI_TEAM_NAME, options.name);
    const result = await hostEnv().exec.run("herdr", ["agent", "start", carrierName, "--kind", "pi", "--pane", paneId,
      "--timeout", String(AGENT_READY_TIMEOUT_MS), "--", ...piAgentArgs(spawnArgv(options))], { timeoutMs: AGENT_READY_TIMEOUT_MS + 1000 });
    if (result.kind === "timeout" || result.kind === "aborted") return { state: "unknown", fact: result.kind };
    if (result.kind === "spawn_failed") return { state: "refused", fact: `spawn_failed:${result.code}` };
    try {
      const envelope = readHerdrEnvelope(result);
      if (envelope.error || result.status !== 0) {
        // A readiness timeout can follow successful actuation. Only explicit pre-actuation refusal is decisive.
        const error = envelope.error ? new HerdrRequestError(envelope.error) : undefined;
        const fact = error?.fact ?? result.stderr;
        const code = error?.code;
        return { state: ["agent_pane_busy", "pane_not_found", "invalid_params", "unsupported_agent_kind"].includes(String(code)) ? "refused" : "unknown", fact };
      }
      if (!result.stdout.trim()) throw new Error("Start success requires stdout evidence.");
      assertReadyStart(herdrResult(envelope), carrierName, paneId);
      return { state: "started", fact: "agent_start_accepted" };
    } catch { return { state: "unknown", fact: "malformed_start_reply" }; }
  }

  /** Keep each destructive query ordered; timeout never establishes absence. */
  async killAsync(paneId: string): Promise<void> {
    if (!paneId) return;
    try {
      const target = await this.invokeAsync(["pane", "get", paneId]);
      const workspaceId = this.closeWorkspace(paneId, target);
      const listed = await this.invokeAsync(["pane", "list", "--workspace", workspaceId]);
      this.assertNotFinalPane(paneId, workspaceId, listed);
      await this.invokeAsync(["pane", "close", paneId]);
    } catch (error) { if (!isPaneNotFound(error)) throw error; }
  }

  async isAliveAsync(paneId: string): Promise<boolean> {
    if (!paneId) return false;
    try {
      this.assertExactPane(paneId, await this.invokeAsync(["pane", "get", paneId]));
      return this.hasShell(paneId, await this.invokeAsync(["pane", "process-info", "--pane", paneId]));
    } catch (error) { if (isPaneNotFound(error)) return false; throw error; }
  }

  private assertExactPane(paneId: string, result: Record<string, unknown>): Record<string, unknown> {
    const pane = result.pane;
    if (!pane || typeof pane !== "object" || Array.isArray(pane)
      || (pane as Record<string, unknown>).pane_id !== paneId) {
      throw new Error("Herdr pane get response did not include the requested pane.");
    }
    return pane as Record<string, unknown>;
  }

  private closeWorkspace(paneId: string, result: Record<string, unknown>): string {
    const workspaceId = this.assertExactPane(paneId, result).workspace_id;
    if (typeof workspaceId !== "string" || !workspaceId) throw new Error("Herdr pane get response did not include workspace_id.");
    return workspaceId;
  }

  private assertNotFinalPane(paneId: string, workspaceId: string, result: Record<string, unknown>): void {
    const listed = result.panes;
    if (!Array.isArray(listed) || !listed.every(pane => pane && typeof pane === "object" && !Array.isArray(pane))) {
      throw new Error("Herdr pane list response did not include panes.");
    }
    if (listed.length <= 1) throw new Error(`Refusing to close Herdr pane ${paneId}: it is the last pane in workspace ${workspaceId}, and close would delete the workspace.`);
  }

  private hasShell(paneId: string, result: Record<string, unknown>): boolean {
    const info = result.process_info;
    if (!info || typeof info !== "object" || Array.isArray(info)
      || (info as Record<string, unknown>).pane_id !== paneId) throw new Error("Herdr pane process-info response did not include the requested pane.");
    const shellPid = (info as Record<string, unknown>).shell_pid;
    if (shellPid === null) return false;
    if (typeof shellPid !== "number" || !Number.isInteger(shellPid) || shellPid <= 0) throw new Error("Herdr pane process-info response did not include a usable shell_pid.");
    return true;
  }

  kill(paneId: string): void {
    if (!paneId) return;
    try {
      const workspaceId = this.closeWorkspace(paneId, this.invoke(["pane", "get", paneId]));
      this.assertNotFinalPane(paneId, workspaceId, this.invoke(["pane", "list", "--workspace", workspaceId]));
      this.invoke(["pane", "close", paneId]);
    } catch (error) {
      if (!isPaneNotFound(error)) throw error;
    }
  }

  isAlive(paneId: string): boolean {
    if (!paneId) return false;
    try {
      this.assertExactPane(paneId, this.invoke(["pane", "get", paneId]));
      return this.hasShell(paneId, this.invoke(["pane", "process-info", "--pane", paneId]));
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
