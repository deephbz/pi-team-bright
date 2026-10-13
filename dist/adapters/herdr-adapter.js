"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HerdrAdapter = void 0;
exports.herdrCarrierName = herdrCarrierName;
const host_env_1 = require("../env/host-env");
const terminal_adapter_1 = require("../utils/terminal-adapter");
const node_crypto_1 = require("node:crypto");
const team_pane_layout_1 = require("../utils/team-pane-layout");
const FORWARDED_ENV = /^(?:PI_[A-Z0-9_]+|HTTP_PROXY|HTTPS_PROXY|WSS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|wss_proxy|all_proxy|no_proxy)$/;
const SHELL_READY_RETRY_MS = 50;
const SHELL_READY_TIMEOUT_MS = 5_000;
/** Official Herdr agent-start readiness bound in milliseconds. */
const AGENT_READY_TIMEOUT_MS = 300_000;
/** Herdr applies a right-split ratio to the existing (leader) pane. */
function currentHerdrPane() {
    const paneId = (0, host_env_1.hostEnv)().process.env.HERDR_PANE_ID?.trim();
    return paneId || null;
}
function currentHerdrTab() {
    const tabId = (0, host_env_1.hostEnv)().process.env.HERDR_TAB_ID?.trim();
    return tabId || null;
}
function errorText(error) {
    const code = typeof error?.code === "string" ? error.code : "unknown_error";
    const message = typeof error?.message === "string" ? error.message : "Herdr returned an invalid error response";
    return `${code}: ${message}`;
}
function parseEnvelope(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        throw new Error("Herdr returned malformed JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Herdr returned an invalid JSON envelope.");
    }
    return parsed;
}
function resultRecord(envelope) {
    if (envelope.error)
        throw new Error(`Herdr request failed: ${errorText(envelope.error)}`);
    const result = envelope.result ?? envelope;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Herdr returned a response without an object result.");
    }
    return result;
}
function isPaneNotFound(error) {
    return error instanceof Error && /(?:^|\W)pane_not_found(?:\W|$)/.test(error.message);
}
function isAgentPaneBusy(error) {
    return error instanceof Error && /(?:^|\W)agent_pane_busy(?:\W|$)/.test(error.message);
}
function managedPiArgv(response) {
    const argv = response.argv;
    if (!Array.isArray(argv) || argv.length < 1 || argv[0] !== "pi" || argv.some((value) => typeof value !== "string")) {
        throw new Error("Herdr agent_started response did not include canonical Pi argv.");
    }
}
/** Validate the official managed-start response and its exact ready target. */
function assertReadyStart(response, carrierName, paneId) {
    if (response.type !== "agent_started")
        throw new Error("Herdr start response did not identify agent_started.");
    managedPiArgv(response);
    const agent = response.agent;
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
        throw new Error("Herdr start response did not include an agent record.");
    }
    const record = agent;
    if (record.name !== carrierName || record.pane_id !== paneId || typeof record.terminal_id !== "string" || !record.terminal_id) {
        throw new Error(`Herdr start did not prove exact managed target ${carrierName} in pane ${paneId}.`);
    }
    if (record.agent !== "pi" || record.interactive_ready !== true) {
        throw new Error(`Herdr start did not prove interactive recognized Pi agent ${carrierName}.`);
    }
}
/** Herdr names are lowercase identifiers with a fixed 32-character limit. */
function herdrCarrierName(teamName, workerName) {
    const source = teamName?.trim() ? `${teamName.trim()}-${workerName}` : workerName;
    if (/^[a-z][a-z0-9_-]{0,31}$/.test(source))
        return source;
    const normalized = source.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const prefixed = /^[a-z]/.test(normalized) ? normalized : `agent-${normalized}`;
    const digest = (0, node_crypto_1.createHash)("sha256").update(source).digest("hex").slice(0, 8);
    const prefix = (prefixed.slice(0, 23) || "agent").padEnd(1, "a");
    return `${prefix}-${digest}`;
}
/** Herdr owns the `pi` executable for its named Pi agent kind; it receives only Pi CLI arguments. */
function piAgentArgs(argv) {
    if (argv[0] === "node" && argv[1])
        return argv.slice(2);
    return argv.slice(1);
}
/** Herdr terminal-surface implementation; it never shells a teammate argv. */
class HerdrAdapter {
    name = "herdr";
    currentTargetId() {
        return currentHerdrPane();
    }
    renamePane(paneId, label) {
        this.invoke(["pane", "rename", paneId, label]);
    }
    /**
     * Herdr identity may be inherited by an inner tmux server. That preserves
     * surface discovery but does not make tmux a valid carrier for a Herdr Team.
     */
    isDirectCarrier() {
        return !(0, host_env_1.hostEnv)().process.env.TMUX && !(0, host_env_1.hostEnv)().process.env.TMUX_PANE;
    }
    detect() {
        if ((0, host_env_1.hostEnv)().process.env.HERDR_ENV !== "1" || !currentHerdrPane() || !currentHerdrTab())
            return false;
        try {
            return (0, terminal_adapter_1.execCommand)("herdr", ["status", "server"]).status === 0;
        }
        catch {
            return false;
        }
    }
    invoke(args) {
        const response = (0, terminal_adapter_1.execCommand)("herdr", args);
        let envelope;
        try {
            envelope = parseEnvelope(response.stdout);
        }
        catch (error) {
            if (response.status !== 0) {
                throw new Error(`Herdr command failed with status ${response.status}: ${response.stderr || (error instanceof Error ? error.message : String(error))}`);
            }
            throw error;
        }
        if (envelope.error)
            throw new Error(`Herdr request failed: ${errorText(envelope.error)}`);
        if (response.status !== 0) {
            throw new Error(`Herdr command failed with status ${response.status}: ${response.stderr || "unknown error"}`);
        }
        return resultRecord(envelope);
    }
    paneRecord(paneId, query = this.invoke.bind(this)) {
        const pane = query(["pane", "get", paneId]).pane;
        if (!pane || typeof pane !== "object" || Array.isArray(pane)
            || pane.pane_id !== paneId) {
            throw new Error(`Herdr pane ${paneId} is not an exact usable target.`);
        }
        return pane;
    }
    paneLayout(leaderPaneId, query = this.invoke.bind(this)) {
        const layout = query(["pane", "layout", "--pane", leaderPaneId]).layout;
        if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
            throw new Error(`Herdr leader pane ${leaderPaneId} returned no layout; refusing Worker spawn.`);
        }
        const record = layout;
        if (!Array.isArray(record.panes)) {
            throw new Error(`Herdr leader pane ${leaderPaneId} layout has no usable panes; refusing Worker spawn.`);
        }
        const panes = record.panes.filter((pane) => !!pane && typeof pane === "object" && !Array.isArray(pane));
        return { record, panes };
    }
    rectFor(panes, paneId, requireComplete = false) {
        const pane = panes.find((candidate) => candidate.pane_id === paneId);
        const rect = pane?.rect;
        if (!rect || typeof rect !== "object" || Array.isArray(rect)) {
            if (requireComplete)
                throw new Error(`Herdr pane ${paneId} has no usable integer geometry; refusing Worker spawn.`);
            return undefined;
        }
        const { x, y, width, height } = rect;
        if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number"
            || ![x, y, width, height].every(Number.isInteger) || width <= 0 || height <= 0) {
            if (requireComplete)
                throw new Error(`Herdr pane ${paneId} has incomplete integer geometry; refusing Worker spawn.`);
            return undefined;
        }
        return { x, y, width, height };
    }
    assertWorkerRegion(leaderPaneId, workerPaneId, query) {
        const leader = this.paneRecord(leaderPaneId, query);
        const worker = this.paneRecord(workerPaneId, query);
        if (leader.tab_id !== worker.tab_id || leader.workspace_id !== worker.workspace_id) {
            throw new Error(`Herdr Team Worker pane ${workerPaneId} is not in the leader tab; refusing to split it.`);
        }
        const { record, panes } = this.paneLayout(leaderPaneId, query);
        if (record.tab_id !== leader.tab_id || record.workspace_id !== leader.workspace_id) {
            throw new Error(`Herdr leader pane ${leaderPaneId} layout does not prove its exact tab; refusing Worker spawn.`);
        }
        const horizontalRect = (paneId) => {
            const pane = panes.find((candidate) => candidate.pane_id === paneId);
            const rect = pane?.rect;
            if (!rect || typeof rect !== "object" || Array.isArray(rect))
                return undefined;
            const { x, width } = rect;
            return typeof x === "number" && typeof width === "number" && Number.isInteger(x) && Number.isInteger(width)
                ? { x, width } : undefined;
        };
        const leaderRect = horizontalRect(leaderPaneId);
        const workerRect = horizontalRect(workerPaneId);
        if (!leaderRect || !workerRect || workerRect.x < leaderRect.x + leaderRect.width) {
            throw new Error(`Herdr Team Worker pane ${workerPaneId} is outside the leader Worker region; refusing to split it.`);
        }
    }
    firstWorkerLeaderShare(leaderPaneId, leaderShare, enforceMinimum = false, leaderIdentity, query) {
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
                ? pane.rect.width : undefined;
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
        if (enforceMinimum && (requestedLeaderWidth < team_pane_layout_1.MIN_WORKER_PANE_WIDTH || workerWidth < team_pane_layout_1.MIN_WORKER_PANE_WIDTH
            || rect.height < team_pane_layout_1.MIN_WORKER_PANE_HEIGHT)) {
            throw new Error(`Herdr pane geometry is insufficient for the first Worker: leader and Worker panes require at least ${team_pane_layout_1.MIN_WORKER_PANE_WIDTH}x${team_pane_layout_1.MIN_WORKER_PANE_HEIGHT}.`);
        }
        return String(requestedLeaderWidth / width);
    }
    /** Choose the largest viable registered Worker pane from the live Herdr layout. */
    adaptiveSplit(leaderPaneId, workerPaneIds, columnsPerRow, query) {
        const leader = this.paneRecord(leaderPaneId, query);
        if (typeof leader.tab_id !== "string" || !leader.tab_id || typeof leader.workspace_id !== "string" || !leader.workspace_id) {
            throw new Error(`Herdr leader pane ${leaderPaneId} has no exact tab or workspace identity; refusing Worker spawn.`);
        }
        const registered = workerPaneIds.flatMap((paneId) => {
            try {
                return [{ paneId, pane: this.paneRecord(paneId, query) }];
            }
            catch (error) {
                if (isPaneNotFound(error))
                    return [];
                throw error;
            }
        });
        // Membership registration supplies the candidate set. A moved or otherwise
        // unusable candidate is ignored; a valid registered candidate can still be
        // selected without falling back to an ambient pane.
        const eligibleRegistered = registered.filter(({ pane }) => leader.tab_id === pane.tab_id && leader.workspace_id === pane.workspace_id);
        const { record, panes } = this.paneLayout(leaderPaneId, query);
        if (record.tab_id !== leader.tab_id || record.workspace_id !== leader.workspace_id) {
            throw new Error(`Herdr leader pane ${leaderPaneId} layout does not prove its exact tab; refusing Worker spawn.`);
        }
        const leaderRect = this.rectFor(panes, leaderPaneId, true);
        if (!leaderRect)
            throw new Error(`Herdr leader pane ${leaderPaneId} has no usable geometry; refusing Worker spawn.`);
        const candidates = [];
        for (const { paneId } of eligibleRegistered) {
            const rect = this.rectFor(panes, paneId);
            if (!rect || rect.x < leaderRect.x + leaderRect.width
                || rect.y < leaderRect.y || rect.y + rect.height > leaderRect.y + leaderRect.height)
                continue;
            const horizontal = rect.width / columnsPerRow >= rect.height;
            const splitSize = horizontal ? rect.width : rect.height;
            const firstChild = Math.floor(splitSize / 2);
            const secondChild = splitSize - firstChild;
            const childWidth = horizontal ? firstChild : rect.width;
            const childHeight = horizontal ? rect.height : firstChild;
            const secondChildWidth = horizontal ? secondChild : rect.width;
            const secondChildHeight = horizontal ? rect.height : secondChild;
            if (childWidth < team_pane_layout_1.MIN_WORKER_PANE_WIDTH || secondChildWidth < team_pane_layout_1.MIN_WORKER_PANE_WIDTH
                || childHeight < team_pane_layout_1.MIN_WORKER_PANE_HEIGHT || secondChildHeight < team_pane_layout_1.MIN_WORKER_PANE_HEIGHT)
                continue;
            candidates.push({
                paneId,
                score: Math.max(rect.width / columnsPerRow, rect.height),
                direction: horizontal ? "right" : "down",
            });
        }
        candidates.sort((a, b) => b.score - a.score || (a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0));
        const selected = candidates[0];
        if (!selected) {
            throw new Error(`Insufficient Herdr pane geometry for another Worker: every registered Worker pane would create a child below ${team_pane_layout_1.MIN_WORKER_PANE_WIDTH}x${team_pane_layout_1.MIN_WORKER_PANE_HEIGHT}.`);
        }
        return { targetPaneId: selected.paneId, direction: selected.direction };
    }
    spawn(options) {
        const paneId = this.prepareSpawn(options);
        void this.startPrepared(paneId, options);
        return paneId;
    }
    /** Create location only. The caller records it before it starts Pi. */
    splitArgs(options, query) {
        if (!options.argv)
            throw new Error("Herdr spawn requires structured argv; legacy command strings are unsupported.");
        if (!options.panePlacement)
            throw new Error("Herdr Worker spawn requires exact Team pane placement.");
        (0, terminal_adapter_1.validateSpawnOptions)(options);
        const { leaderPaneId, workerPaneIds } = options.panePlacement;
        const paneLayout = options.panePlacement.paneLayout ?? team_pane_layout_1.DEFAULT_TEAM_PANE_LAYOUT;
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
        let adaptiveTarget;
        if (workerCount > 0 && adaptive) {
            adaptiveTarget = this.adaptiveSplit(leaderPaneId, workerPaneIds, paneLayout.columns_per_row ?? team_pane_layout_1.DEFAULT_COLUMNS_PER_ROW, query);
        }
        const targetPaneId = workerCount === 0 ? leaderPaneId : adaptiveTarget?.targetPaneId ?? workerPaneIds.at(-1);
        const direction = workerCount === 0 ? "right" : adaptiveTarget?.direction ?? "down";
        const firstWorkerLeaderShare = workerCount === 0
            ? (() => {
                const leaderRecord = this.paneRecord(targetPaneId, query);
                return this.firstWorkerLeaderShare(leaderPaneId, paneLayout.leader_share, adaptive, leaderRecord, query);
            })()
            : undefined;
        if (workerCount > 0 && !adaptive)
            this.assertWorkerRegion(leaderPaneId, targetPaneId, query);
        const envArgs = Object.entries(options.env)
            .filter(([key, value]) => FORWARDED_ENV.test(key) && !value.includes("\0"))
            .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
        return [
            "pane", "split", "--pane", targetPaneId,
            "--direction", direction,
            "--ratio", workerCount > 0 ? "0.5" : firstWorkerLeaderShare,
            "--cwd", options.cwd,
            ...envArgs,
            "--no-focus",
        ];
    }
    prepareSpawn(options) {
        const split = this.invoke(this.splitArgs(options, this.invoke.bind(this)));
        const pane = split.pane;
        const paneId = pane && typeof pane === "object" && !Array.isArray(pane)
            ? pane.pane_id
            : undefined;
        if (typeof paneId !== "string" || !paneId) {
            throw new Error("Herdr pane split response did not include pane.pane_id.");
        }
        try {
            this.renamePane(paneId, options.name);
        }
        catch (error) {
            console.warn(`[pi-teams] Herdr Worker pane ${paneId} could not be named: ${error instanceof Error ? error.message : String(error)}`);
        }
        return paneId;
    }
    async invokeAsync(args, deadline) {
        const timeoutMs = Math.min(2000, deadline - (0, host_env_1.hostEnv)().clock.now());
        if (timeoutMs <= 0)
            throw new Error("herdr_preparation_budget_expired");
        const result = await (0, host_env_1.hostEnv)().exec.run("herdr", args, { timeoutMs });
        if (result.kind !== "exited")
            throw new Error(`herdr_${args[1]}_${result.kind}`);
        const envelope = parseEnvelope(result.stdout);
        if (envelope.error)
            throw new Error(errorText(envelope.error));
        if (result.status !== 0)
            throw new Error(`herdr_${args[1]}_exit:${result.status}`);
        return resultRecord(envelope);
    }
    /** Snapshot placement asynchronously; geometry uses the same algorithm as legacy callers. */
    async prepareSpawnAsync(options, deadline = (0, host_env_1.hostEnv)().clock.now() + 9000) {
        if (!options.panePlacement)
            throw new Error("Herdr Worker spawn requires exact Team pane placement.");
        const { leaderPaneId, workerPaneIds } = options.panePlacement;
        const queries = [["pane", "layout", "--pane", leaderPaneId], ...[leaderPaneId, ...workerPaneIds].map(id => ["pane", "get", id])];
        const snapshot = new Map(await Promise.all(queries.map(async (args) => {
            try {
                return [JSON.stringify(args), await this.invokeAsync(args, deadline)];
            }
            catch (error) {
                return [JSON.stringify(args), error instanceof Error ? error : new Error(String(error))];
            }
        })));
        const splitArgs = this.splitArgs(options, args => {
            const value = snapshot.get(JSON.stringify(args));
            if (value instanceof Error)
                throw value;
            if (!value)
                throw new Error("Herdr placement snapshot is incomplete.");
            return value;
        });
        const split = await this.invokeAsync(splitArgs, deadline);
        const paneId = split.pane?.pane_id;
        if (typeof paneId !== "string" || !paneId)
            throw new Error("Herdr pane split response did not include pane.pane_id.");
        // Naming failure cannot discard a created target or authorize another split.
        try {
            await this.invokeAsync(["pane", "rename", paneId, options.name], deadline);
        }
        catch (error) {
            console.warn(`[pi-teams] Herdr Worker pane ${paneId} could not be named: ${error instanceof Error ? error.message : String(error)}`);
        }
        return paneId;
    }
    async startPrepared(paneId, options) {
        const deadline = (0, host_env_1.hostEnv)().clock.now() + SHELL_READY_TIMEOUT_MS;
        for (;;) {
            const result = await this.startOnce(paneId, options);
            if (result.state !== "refused" || !result.fact.startsWith("agent_pane_busy:") || (0, host_env_1.hostEnv)().clock.now() >= deadline)
                return result;
            await new Promise(resolve => (0, host_env_1.hostEnv)().clock.setTimeout(resolve, SHELL_READY_RETRY_MS));
        }
    }
    async startOnce(paneId, options) {
        const carrierName = herdrCarrierName(options.env.PI_TEAM_NAME, options.name);
        const result = await (0, host_env_1.hostEnv)().exec.run("herdr", ["agent", "start", carrierName, "--kind", "pi", "--pane", paneId,
            "--timeout", String(AGENT_READY_TIMEOUT_MS), "--", ...piAgentArgs((0, terminal_adapter_1.spawnArgv)(options))], { timeoutMs: AGENT_READY_TIMEOUT_MS + 1000 });
        if (result.kind === "timeout" || result.kind === "aborted")
            return { state: "unknown", fact: result.kind };
        if (result.kind === "spawn_failed")
            return { state: "refused", fact: `spawn_failed:${result.code}` };
        try {
            const envelope = parseEnvelope(result.stdout.trim() ? result.stdout : result.stderr);
            if (envelope.error || result.status !== 0) {
                // A readiness timeout can follow successful actuation. Only explicit pre-actuation refusal is decisive.
                const fact = envelope.error ? errorText(envelope.error) : result.stderr;
                const code = envelope.error && typeof envelope.error === "object" ? envelope.error.code : undefined;
                return { state: ["agent_pane_busy", "pane_not_found", "invalid_params", "unsupported_agent_kind"].includes(String(code)) ? "refused" : "unknown", fact };
            }
            if (!result.stdout.trim())
                throw new Error("Start success requires stdout evidence.");
            assertReadyStart(resultRecord(envelope), carrierName, paneId);
            return { state: "started", fact: "agent_start_accepted" };
        }
        catch {
            return { state: "unknown", fact: "malformed_start_reply" };
        }
    }
    kill(paneId) {
        if (!paneId)
            return;
        try {
            const target = this.invoke(["pane", "get", paneId]).pane;
            if (!target || typeof target !== "object" || Array.isArray(target)) {
                throw new Error("Herdr pane get response did not include the requested pane.");
            }
            const workspaceId = target.workspace_id;
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
        }
        catch (error) {
            if (!isPaneNotFound(error))
                throw error;
        }
    }
    isAlive(paneId) {
        if (!paneId)
            return false;
        try {
            const result = this.invoke(["pane", "get", paneId]);
            const pane = result.pane;
            if (!pane || typeof pane !== "object" || Array.isArray(pane)
                || pane.pane_id !== paneId) {
                throw new Error("Herdr pane get response did not include the requested pane.");
            }
            const processResult = this.invoke(["pane", "process-info", "--pane", paneId]);
            const processInfo = processResult.process_info;
            if (!processInfo || typeof processInfo !== "object" || Array.isArray(processInfo)
                || processInfo.pane_id !== paneId) {
                throw new Error("Herdr pane process-info response did not include the requested pane.");
            }
            const shellPid = processInfo.shell_pid;
            return typeof shellPid === "number" && Number.isInteger(shellPid) && shellPid > 0;
        }
        catch (error) {
            if (isPaneNotFound(error))
                return false;
            throw error;
        }
    }
    setTitle(_title) {
        // Herdr owns recognized-agent lifecycle while `agent start` waits for Pi.
        // Do not mutate pane or display metadata from inside that startup window.
    }
    supportsWindows() {
        return false;
    }
    spawnWindow(_options) {
        throw new Error("Herdr does not support spawning separate OS windows.");
    }
    setWindowTitle(_windowId, _title) {
        // Herdr Teams stay within one originating tab.
    }
    killWindow(_windowId) {
        // Herdr Teams stay within one originating tab.
    }
    isWindowAlive(_windowId) {
        return false;
    }
}
exports.HerdrAdapter = HerdrAdapter;
