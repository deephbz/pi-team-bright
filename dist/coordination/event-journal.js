"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidTeamSnapshotContinuationError = exports.TeamEventCursorAheadError = exports.MAX_TEAM_SYNC_LIMIT = exports.DEFAULT_TEAM_SYNC_LIMIT = void 0;
exports.appendTeamEvent = appendTeamEvent;
exports.appendTaskEvidenceEvent = appendTaskEvidenceEvent;
exports.projectTaskEventEvidence = projectTaskEventEvidence;
exports.readTeamEvents = readTeamEvents;
exports.readTeamEventPages = readTeamEventPages;
exports.readTeamEventCursor = readTeamEventCursor;
exports.readTaskActivity = readTaskActivity;
exports.waitForTeamEvents = waitForTeamEvents;
exports.syncTeamEvents = syncTeamEvents;
exports.projectTeamCurrentState = projectTeamCurrentState;
exports.pageTeamCurrentProjection = pageTeamCurrentProjection;
exports.hydrateTeamSyncTasks = hydrateTeamSyncTasks;
const host_env_1 = require("../env/host-env");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const lock_1 = require("../utils/lock");
const task_domain_1 = require("../task-authority/task-domain");
const paths_1 = require("../utils/paths");
// Event/wait intent and authority boundaries: docs/current/README.md and
// docs/reference.md.
const EVENT_SCHEMA = "pi-teams-event-journal/1";
const ZERO_CURSOR = "0";
exports.DEFAULT_TEAM_SYNC_LIMIT = 50;
exports.MAX_TEAM_SYNC_LIMIT = 100;
class TeamEventCursorAheadError extends Error {
    requestedCursor;
    headCursor;
    name = "TeamEventCursorAheadError";
    constructor(requestedCursor, headCursor) {
        super(`Team event cursor ${requestedCursor} is ahead of journal head ${headCursor}; request a fresh snapshot instead of regressing the cursor.`);
        this.requestedCursor = requestedCursor;
        this.headCursor = headCursor;
    }
}
exports.TeamEventCursorAheadError = TeamEventCursorAheadError;
class InvalidTeamSnapshotContinuationError extends Error {
    name = "InvalidTeamSnapshotContinuationError";
}
exports.InvalidTeamSnapshotContinuationError = InvalidTeamSnapshotContinuationError;
function validatedLimit(limit) {
    const value = limit ?? exports.DEFAULT_TEAM_SYNC_LIMIT;
    if (!Number.isSafeInteger(value) || value < 1 || value > exports.MAX_TEAM_SYNC_LIMIT) {
        throw new Error(`limit must be an integer from 1 through ${exports.MAX_TEAM_SYNC_LIMIT}.`);
    }
    return value;
}
function parseCursor(cursor) {
    const value = cursor ?? ZERO_CURSOR;
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`Invalid Team event cursor ${JSON.stringify(value)}.`);
    }
    return BigInt(value);
}
function assertString(value, field) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Malformed Team event: ${field} must be a nonempty string.`);
    }
}
function upgradeRequiredVersion(lineNumber, field) {
    const error = new Error(`Team event journal at line ${lineNumber} contains a non-canonical ${field}; run the stopped-epoch migration.`);
    error.name = "upgrade_required";
    return error;
}
function parseEvent(line, lineNumber) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid JSON.`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Malformed Team event journal at line ${lineNumber}: expected an object.`);
    }
    const event = value;
    assertString(event.cursor, "cursor");
    parseCursor(event.cursor);
    assertString(event.at, "at");
    if (event.type === "task") {
        if (!event.ref || typeof event.ref !== "object" || Array.isArray(event.ref)) {
            throw new Error(`Malformed Team event journal at line ${lineNumber}: task ref is required.`);
        }
        const ref = event.ref;
        assertString(ref.taskId, "ref.taskId");
        assertString(ref.version, "ref.version");
        assertString(event.actor, "actor");
        if (!["created", "assigned", "goal", "note", "status", "relation"].includes(String(event.change))) {
            throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid task change.`);
        }
        if (event.taskEvidence !== undefined) {
            if (!event.taskEvidence || typeof event.taskEvidence !== "object" || Array.isArray(event.taskEvidence)) {
                throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid task evidence.`);
            }
            const evidence = event.taskEvidence;
            if (!["created", "goal", "assignment", "progress", "status", "relation", "decision", "blocker", "result", "note"].includes(String(evidence.kind))) {
                throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid task evidence kind.`);
            }
            assertString(evidence.text, "taskEvidence.text");
        }
    }
    else if (event.type === "worker") {
        assertString(event.worker, "worker");
        assertString(event.membershipId, "membershipId");
        if (!["prepared", "session_bound", "stopped", "failed", "carrier"].includes(String(event.phase))) {
            throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid worker phase.`);
        }
        if (event.generation !== undefined) {
            if (event.phase !== "session_bound")
                throw new Error(`Malformed Team event journal at line ${lineNumber}: generation is session_bound-only.`);
            if (!event.generation || typeof event.generation !== "object" || Array.isArray(event.generation))
                throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid worker generation.`);
            const generation = event.generation;
            assertString(generation.membershipId, "generation.membershipId");
            if (generation.membershipId !== event.membershipId || !Number.isSafeInteger(generation.pid) || Number(generation.pid) <= 1 || !Number.isSafeInteger(generation.startedAt) || Number(generation.startedAt) <= 0)
                throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid worker generation.`);
        }
    }
    else if (event.type === "alert") {
        assertString(event.alertId, "alertId");
        assertString(event.from, "from");
        assertString(event.to, "to");
        assertString(event.text, "text");
        if (!["clarification", "attention", "announcement"].includes(String(event.kind))) {
            throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid alert kind.`);
        }
        if (event.taskRef !== undefined) {
            if (!event.taskRef || typeof event.taskRef !== "object" || Array.isArray(event.taskRef)) {
                throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid alert taskRef.`);
            }
            const taskRef = event.taskRef;
            assertString(taskRef.taskId, "taskRef.taskId");
            if (taskRef.version !== undefined)
                assertString(taskRef.version, "taskRef.version");
        }
    }
    else {
        throw new Error(`Malformed Team event journal at line ${lineNumber}: invalid event type.`);
    }
    if (event.type === "task") {
        const ref = event.ref;
        if (!/^v_[0-9a-f]{16}$/.test(ref.version))
            throw upgradeRequiredVersion(lineNumber, "task ref version");
        return {
            ...event,
            ref: {
                taskId: ref.taskId,
                version: ref.version,
            },
        };
    }
    if (event.type === "alert" && event.taskRef) {
        const taskRef = event.taskRef;
        return {
            ...event,
            taskRef: {
                taskId: taskRef.taskId,
                ...(taskRef.version !== undefined
                    ? (!/^v_[0-9a-f]{16}$/.test(taskRef.version)
                        ? (() => { throw upgradeRequiredVersion(lineNumber, "alert task ref version"); })()
                        : { version: taskRef.version })
                    : {}),
            },
        };
    }
    return value;
}
function readJournal(teamName) {
    const journal = (0, paths_1.teamEventJournalPath)(teamName);
    if (!node_fs_1.default.existsSync(journal))
        return [];
    const raw = node_fs_1.default.readFileSync(journal, "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    let previous = 0n;
    return lines.map((line, index) => {
        const event = parseEvent(line, index + 1);
        const cursor = parseCursor(event.cursor);
        if (cursor <= previous) {
            throw new Error(`Malformed Team event journal at line ${index + 1}: cursors must increase monotonically.`);
        }
        previous = cursor;
        return event;
    });
}
function writeCursorProjection(teamName, cursor) {
    const target = (0, paths_1.teamEventCursorStatePath)(teamName);
    const directory = node_path_1.default.dirname(target);
    const temp = node_path_1.default.join(directory, `.${node_path_1.default.basename(target)}.${(0, host_env_1.hostEnv)().process.pid}.${(0, host_env_1.hostEnv)().clock.now()}.tmp`);
    node_fs_1.default.writeFileSync(temp, JSON.stringify({ schema: EVENT_SCHEMA, cursor, updatedAt: new Date((0, host_env_1.hostEnv)().clock.now()).toISOString() }), {
        flag: "wx",
        mode: 0o600,
    });
    node_fs_1.default.renameSync(temp, target);
}
/**
 * Append one observation after its owning authority commits. The JSONL is the
 * evidence authority; cursor.json is only a rebuildable latest-position view.
 */
async function appendTeamEvent(teamName, input) {
    if (!node_fs_1.default.existsSync((0, paths_1.configPath)(teamName)))
        throw new Error(`Team ${teamName} not found`);
    const journal = (0, paths_1.teamEventJournalPath)(teamName);
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(journal), { recursive: true });
    return (0, lock_1.withLock)(journal, async () => {
        const events = readJournal(teamName);
        const cursor = ((events.length ? parseCursor(events[events.length - 1].cursor) : 0n) + 1n).toString();
        const event = { ...input, cursor, at: new Date((0, host_env_1.hostEnv)().clock.now()).toISOString() };
        // Validate before committing so a structurally invalid internal caller
        // cannot poison the append-only journal.
        parseEvent(JSON.stringify(event), events.length + 1);
        const fd = node_fs_1.default.openSync(journal, "a", 0o600);
        try {
            node_fs_1.default.writeSync(fd, `${JSON.stringify(event)}\n`);
            node_fs_1.default.fsyncSync(fd);
        }
        finally {
            node_fs_1.default.closeSync(fd);
        }
        writeCursorProjection(teamName, cursor);
        return event;
    });
}
/** Append structured Task evidence and return its committed identity/time. */
async function appendTaskEvidenceEvent(teamName, input) {
    return await appendTeamEvent(teamName, input);
}
/** Project only committed event coordinates; caller prose never supplies IDs or time. */
function projectTaskEventEvidence(event) {
    if (event.type !== "task" || !("taskEvidence" in event))
        return undefined;
    const evidence = event.taskEvidence;
    return {
        id: `task-event-${event.cursor}`,
        at: event.at,
        actor: event.actor,
        kind: evidence.kind,
        text: evidence.text,
    };
}
/** Non-consuming read: each caller owns its supplied cursor. */
function readTeamEvents(teamName, options = {}) {
    const after = parseCursor(options.afterCursor);
    const events = readJournal(teamName);
    const headCursor = events.at(-1)?.cursor ?? ZERO_CURSOR;
    if (after > parseCursor(headCursor)) {
        throw new TeamEventCursorAheadError(options.afterCursor, headCursor);
    }
    const types = options.eventTypes ? new Set(options.eventTypes) : undefined;
    const taskIds = options.taskIds ? new Set(options.taskIds) : undefined;
    const limit = validatedLimit(options.limit);
    const matching = events.filter((event) => {
        if (parseCursor(event.cursor) <= after || (types && !types.has(event.type)))
            return false;
        if (!taskIds)
            return true;
        if (event.type === "task")
            return taskIds.has(event.ref.taskId);
        if (event.type === "alert")
            return !!event.taskRef && taskIds.has(event.taskRef.taskId);
        // A Task-targeted sync must not let unrelated Worker telemetry crowd the
        // requested semantic changes out of a bounded page.
        return false;
    });
    const selected = matching.slice(0, limit);
    const remaining = matching.length - selected.length;
    const truncated = remaining > 0;
    return {
        cursor: truncated ? selected.at(-1).cursor : headCursor,
        headCursor,
        events: selected,
        truncated,
        remaining,
    };
}
/** Read one journal image and split unseen events into bounded observation pages. */
function readTeamEventPages(teamName, options = {}) {
    const after = parseCursor(options.afterCursor);
    const events = readJournal(teamName);
    const headCursor = events.at(-1)?.cursor ?? ZERO_CURSOR;
    if (after > parseCursor(headCursor)) {
        throw new TeamEventCursorAheadError(options.afterCursor, headCursor);
    }
    const limit = validatedLimit(options.limit);
    const unseen = events.filter((event) => parseCursor(event.cursor) > after);
    if (unseen.length === 0) {
        return [{ events: [], cursor: headCursor, headCursor, truncated: false, remaining: 0 }];
    }
    const pages = [];
    for (let offset = 0; offset < unseen.length; offset += limit) {
        const selected = unseen.slice(offset, offset + limit);
        const remaining = unseen.length - offset - selected.length;
        pages.push({
            events: selected,
            cursor: remaining > 0 ? selected.at(-1).cursor : headCursor,
            headCursor,
            truncated: remaining > 0,
            remaining,
        });
    }
    return pages;
}
function readTeamEventCursor(teamName) {
    return readJournal(teamName).at(-1)?.cursor ?? ZERO_CURSOR;
}
/**
 * Read the journal once and project only latest per-Task activity coordinates.
 * This is ordering evidence for derived views, not Task state authority.
 */
function readTaskActivity(teamName) {
    const events = readJournal(teamName);
    const activity = new Map();
    for (const event of events) {
        if (event.type !== "task")
            continue;
        const prior = activity.get(event.ref.taskId);
        activity.set(event.ref.taskId, {
            taskId: event.ref.taskId,
            cursor: event.cursor,
            firstActivityAt: prior?.firstActivityAt ?? event.at,
            lastActivityAt: event.at,
        });
    }
    return {
        headCursor: events.at(-1)?.cursor ?? ZERO_CURSOR,
        tasks: [...activity.values()].sort((a, b) => {
            const left = parseCursor(a.cursor);
            const right = parseCursor(b.cursor);
            return right > left ? 1 : right < left ? -1 : a.taskId.localeCompare(b.taskId);
        }),
    };
}
function abortError() {
    const error = new Error("Team event wait aborted");
    error.name = "AbortError";
    return error;
}
/** Event-driven check-register-check wait; filesystem notifications are hints. */
async function waitForTeamEvents(options) {
    const waitMs = options.waitMs ?? 0;
    if (!Number.isFinite(waitMs) || waitMs < 0)
        throw new Error("waitMs must be a nonnegative finite number.");
    if (options.signal?.aborted)
        throw abortError();
    const read = () => readTeamEvents(options.teamName, options);
    const initial = read();
    if (initial.events.length > 0 || waitMs === 0)
        return { ...initial, timedOut: false };
    const journal = (0, paths_1.teamEventJournalPath)(options.teamName);
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(journal), { recursive: true });
    const clock = (0, host_env_1.hostEnv)().clock;
    return new Promise((resolve, reject) => {
        let settled = false;
        let scanning = false;
        let rescan = false;
        let timer;
        const finish = (action) => {
            if (settled)
                return;
            settled = true;
            clock.clearTimeout(timer);
            watcher.close();
            options.signal?.removeEventListener("abort", onAbort);
            action();
        };
        const scan = () => {
            if (settled)
                return;
            if (scanning) {
                rescan = true;
                return;
            }
            scanning = true;
            try {
                const batch = read();
                if (batch.events.length > 0)
                    finish(() => resolve({ ...batch, timedOut: false }));
            }
            catch (error) {
                finish(() => reject(error));
            }
            finally {
                scanning = false;
                if (rescan && !settled) {
                    rescan = false;
                    queueMicrotask(scan);
                }
            }
        };
        const onAbort = () => finish(() => reject(abortError()));
        const watcher = (0, host_env_1.hostEnv)().watch.watchDirectory(node_path_1.default.dirname(journal), (filename) => {
            if (!filename || filename.toString() === node_path_1.default.basename(journal))
                scan();
        });
        watcher.onError((error) => finish(() => reject(error)));
        options.signal?.addEventListener("abort", onAbort, { once: true });
        timer = clock.setTimeout(() => {
            try {
                const batch = read();
                finish(() => resolve({ ...batch, timedOut: true }));
            }
            catch (error) {
                finish(() => reject(error));
            }
        }, waitMs);
        if ("unref" in timer)
            timer.unref();
        // Close the lost-wakeup gap between the first read and watcher creation.
        scan();
    });
}
/** Snapshot mode returns the current cursor without replaying history. */
async function syncTeamEvents(options) {
    if (options.cursor === undefined) {
        const cursor = readTeamEventCursor(options.teamName);
        return { cursor, headCursor: cursor, events: [], truncated: false, remaining: 0, timedOut: false };
    }
    return waitForTeamEvents({ ...options, afterCursor: options.cursor });
}
function latestWorkerMemberships(members) {
    const latest = new Map();
    for (const member of members) {
        if (member.agentType === "teammate")
            latest.set(member.name, member);
    }
    return latest;
}
/**
 * Build the compact current projection from authoritative records already read
 * by the caller. This stays pure so the event journal never imports the Task
 * adapter and Task mutations can append events without a dependency cycle.
 */
function projectTeamCurrentState(config, tasks) {
    const taskSummaries = tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        ...(task.assignee ? { assignee: task.assignee } : {}),
        ...(task.version ? { version: task.version } : {}),
    })).sort((left, right) => left.id.localeCompare(right.id));
    const workers = [...latestWorkerMemberships(config.members).values()].map((member) => {
        const current = member.isActive !== false;
        return {
            name: member.name,
            ...(current && member.membershipId ? { membershipId: member.membershipId } : {}),
            carrier: current ? (member.sessionFile ? "session_bound" : "prepared") : "absent",
            nonterminalTasks: tasks
                .filter((task) => task.assignee === member.name && !(0, task_domain_1.isTaskTerminal)(task))
                .map((task) => ({ id: task.id, status: task.status })),
        };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const lifecycle = config.members.some((member) => member.isActive !== false) ? "active" : "stopped";
    return {
        team: {
            name: config.name,
            description: config.description,
            lifecycle,
            ...(config.taskBackend === "beads" && config.taskAuthorityId
                ? { taskAuthority: { backend: "beads", authorityId: config.taskAuthorityId } }
                : {}),
        },
        workers,
        tasks: taskSummaries,
    };
}
function encodeSnapshotContinuation(payload) {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
function decodeSnapshotContinuation(token, teamName, headCursor) {
    let value;
    try {
        value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    }
    catch {
        throw new InvalidTeamSnapshotContinuationError("Snapshot continuation is malformed; request a fresh snapshot.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new InvalidTeamSnapshotContinuationError("Snapshot continuation is malformed; request a fresh snapshot.");
    }
    const payload = value;
    if (payload.schema !== "pi-teams-snapshot-page/1"
        || payload.teamName !== teamName
        || payload.headCursor !== headCursor
        || !Number.isSafeInteger(payload.offset)
        || payload.offset < 0) {
        throw new InvalidTeamSnapshotContinuationError(payload.headCursor !== undefined && payload.headCursor !== headCursor
            ? `Snapshot continuation was issued at cursor ${payload.headCursor}, but journal head is now ${headCursor}; request a fresh snapshot.`
            : "Snapshot continuation does not match this Team; request a fresh snapshot.");
    }
    return payload;
}
/** Bound a compact snapshot and return an opaque continuation pinned to its event head. */
function pageTeamCurrentProjection(projection, options) {
    const limit = validatedLimit(options.limit);
    const offset = options.continuation
        ? decodeSnapshotContinuation(options.continuation, projection.team.name, options.headCursor).offset
        : 0;
    const records = [
        ...projection.workers.map((worker) => ({ kind: "worker", worker })),
        ...projection.tasks.map((task) => ({ kind: "task", task })),
    ];
    if (offset > records.length) {
        throw new InvalidTeamSnapshotContinuationError("Snapshot continuation is beyond the current projection; request a fresh snapshot.");
    }
    const page = records.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const truncated = nextOffset < records.length;
    return {
        projection: {
            team: projection.team,
            workers: page.flatMap((record) => record.kind === "worker" ? [record.worker] : []),
            tasks: page.flatMap((record) => record.kind === "task" ? [record.task] : []),
        },
        offset,
        limit,
        totalItems: records.length,
        truncated,
        ...(truncated ? {
            continuation: encodeSnapshotContinuation({
                schema: "pi-teams-snapshot-page/1",
                teamName: projection.team.name,
                headCursor: options.headCursor,
                offset: nextOffset,
            }),
        } : {}),
    };
}
/** Hydrate changed/requested Task references from their current authority state. */
async function hydrateTeamSyncTasks(events, requestedTaskIds, readTasks) {
    const ids = new Set(requestedTaskIds ?? []);
    for (const event of events) {
        if (event.type === "task")
            ids.add(event.ref.taskId);
        if (event.type === "alert" && event.taskRef)
            ids.add(event.taskRef.taskId);
    }
    return readTasks([...ids]);
}
