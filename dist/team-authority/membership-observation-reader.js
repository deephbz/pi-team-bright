"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readMembershipObservation = readMembershipObservation;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const TEAM_CONFIG_FILENAME = "config.json";
const RUNTIME_DIRECTORY = "runtime";
const yieldRead = () => new Promise(resolve => setImmediate(resolve));
function iso(value) { const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN; try {
    return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
}
catch {
    return undefined;
} }
function validString(value) { return typeof value === "string" && value.length > 0; }
function safeName(value) { return validString(value) && /^[a-zA-Z0-9_-]+$/.test(value); }
function validTarget(value) { return !!value && typeof value === "object" && validString(value.backend) && (value.kind === "pane" || value.kind === "window") && validString(value.targetId); }
function absoluteLocator(value) { return validString(value) && node_path_1.default.isAbsolute(value) && node_path_1.default.normalize(value) === value; }
function parseObject(file) { return JSON.parse(node_fs_1.default.readFileSync(file, "utf8")); }
function configIsUsable(value) { return !!value && typeof value === "object" && validString(value.name) && Array.isArray(value.members); }
function memberIsUsable(member) { return !!member && typeof member === "object" && validString(member.membershipId) && safeName(member.name) && (member.agentType === "lead" || member.agentType === "teammate") && !!iso(member.joinedAt); }
function generation(runtime) { const pid = runtime?.pid; const startedAt = runtime?.startedAt; return runtime && !!runtime.membershipId && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0 ? { membershipId: runtime.membershipId, pid, startedAt } : undefined; }
function expired(options, deadline) { return options.signal?.aborted ? "projection_aborted" : Date.now() >= deadline ? "projection_deadline_exceeded" : undefined; }
function projectMember(teamName, candidate, duplicateIds, ambiguousBindings) {
    const { member, runtime, runtimeState } = candidate;
    const diagnoses = [];
    const membershipId = member.membershipId;
    const memberName = member.name;
    const joinedAt = iso(member.joinedAt);
    const endedAt = iso(member.deactivatedAt);
    const lifecycle = member.isActive === false ? { state: "ended", joinedAt, ...(endedAt ? { endedAt } : {}), ...(member.deactivationReason ? { reason: member.deactivationReason } : {}) } : { state: "current", joinedAt };
    const projected = { membershipId, memberName, coordinationRole: member.agentType === "lead" ? "lead" : "teammate", lifecycle, diagnoses, ...(validTarget(member.terminalTarget) ? { terminalTarget: member.terminalTarget } : {}) };
    if (absoluteLocator(member.sessionFile))
        projected.sessionLocator = member.sessionFile;
    else if (validString(member.sessionFile))
        diagnoses.push("session_locator_invalid");
    if (duplicateIds.has(membershipId))
        diagnoses.push("membership_duplicate");
    if (runtimeState === "missing")
        diagnoses.push("runtime_missing");
    if (runtimeState === "malformed")
        diagnoses.push("runtime_malformed");
    if (runtimeState === "unavailable")
        diagnoses.push("runtime_unavailable");
    const runtimeGeneration = generation(runtime);
    const startedAt = runtimeGeneration && iso(runtimeGeneration.startedAt);
    const generationValid = !!runtime && !!runtimeGeneration && !!startedAt && runtime.membershipId === membershipId && !duplicateIds.has(membershipId) && !ambiguousBindings.has(membershipId);
    if (runtime) {
        if (!runtime.membershipId || !runtimeGeneration || !startedAt)
            diagnoses.push("runtime_legacy");
        else if (runtime.membershipId !== membershipId)
            diagnoses.push("runtime_generation_mismatch");
        else if (ambiguousBindings.has(membershipId))
            diagnoses.push("process_binding_ambiguous");
    }
    if (generationValid) {
        projected.processBinding = { membershipId: runtimeGeneration.membershipId, pid: runtimeGeneration.pid, processStartedAt: startedAt };
        if (typeof runtime.ready === "boolean")
            projected.readiness = runtime.ready;
    }
    return projected;
}
async function projectConfig(config, directory, options, deadline) {
    const candidates = [];
    const diagnoses = [];
    for (const raw of config.members) {
        await yieldRead();
        const stop = expired(options, deadline);
        if (stop)
            return stop;
        if (!memberIsUsable(raw)) {
            diagnoses.push("membership_malformed");
            continue;
        }
        const runtimeFile = node_path_1.default.join(directory, RUNTIME_DIRECTORY, `${raw.name}.json`);
        let runtime = null;
        let runtimeState = "missing";
        try {
            if (node_fs_1.default.existsSync(runtimeFile)) {
                const parsed = parseObject(runtimeFile);
                if (!parsed || typeof parsed !== "object")
                    throw new Error("shape");
                runtime = parsed;
                runtimeState = "present";
            }
        }
        catch {
            runtimeState = "malformed";
        }
        candidates.push({ member: raw, runtime, runtimeState });
    }
    const counts = new Map();
    for (const candidate of candidates) {
        const id = candidate.member.membershipId;
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const duplicateIds = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
    const bindings = new Map();
    for (const candidate of candidates) {
        const runtimeGeneration = generation(candidate.runtime);
        const startedAt = runtimeGeneration && iso(runtimeGeneration.startedAt);
        const id = candidate.member.membershipId;
        if (candidate.member.isActive !== false && runtimeGeneration && startedAt && runtimeGeneration.membershipId === id && !duplicateIds.has(id)) {
            const key = `${runtimeGeneration.pid}:${startedAt}`;
            bindings.set(key, [...(bindings.get(key) ?? []), id]);
        }
    }
    const ambiguous = new Set([...bindings.values()].filter(ids => ids.length > 1).flat());
    return { teamName: config.name, memberships: candidates.map(candidate => projectMember(config.name, candidate, duplicateIds, ambiguous)), diagnoses };
}
async function readTeam(directory, directoryName, options, deadline) {
    const configFile = node_path_1.default.join(directory, TEAM_CONFIG_FILENAME);
    for (let attempt = 0; attempt < 2; attempt++) {
        const stop = expired(options, deadline);
        if (stop)
            return { diagnoses: [], stop };
        let before;
        try {
            before = node_fs_1.default.readFileSync(configFile, "utf8");
        }
        catch {
            return { diagnoses: [{ code: node_fs_1.default.existsSync(configFile) ? "team_config_malformed" : "team_config_missing", teamName: directoryName }] };
        }
        let config;
        try {
            const parsed = JSON.parse(before);
            if (!configIsUsable(parsed))
                throw new Error("shape");
            config = parsed;
        }
        catch {
            return { diagnoses: [{ code: "team_config_malformed", teamName: directoryName }] };
        }
        const projected = await projectConfig(config, directory, options, deadline);
        if (typeof projected === "string")
            return { diagnoses: [], stop: projected };
        const afterStop = expired(options, deadline);
        if (afterStop)
            return { diagnoses: [], stop: afterStop };
        try {
            if (node_fs_1.default.readFileSync(configFile, "utf8") === before)
                return { team: projected, diagnoses: [] };
        }
        catch {
            return { diagnoses: [{ code: "team_unreadable", teamName: directoryName }] };
        }
        if (attempt === 1)
            return { diagnoses: [{ code: "team_changed_during_read", teamName: config.name }] };
    }
    return { diagnoses: [{ code: "team_changed_during_read", teamName: directoryName }] };
}
/** Read lock-free recorded Membership evidence. This module never writes Team or runtime records. */
async function readMembershipObservation(options = {}) {
    const teamsRoot = options.teamsRoot ?? node_path_1.default.join(node_os_1.default.homedir(), ".pi", "teams");
    const deadline = Date.now() + Math.max(0, options.deadlineMs ?? 1_000);
    const result = { teams: [], diagnoses: [] };
    const initialStop = expired(options, deadline);
    if (initialStop) {
        result.diagnoses.push({ code: initialStop });
        return result;
    }
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(teamsRoot);
    }
    catch {
        result.diagnoses.push({ code: "teams_root_unavailable" });
        return result;
    }
    for (const name of entries.sort()) {
        await yieldRead();
        const stop = expired(options, deadline);
        if (stop) {
            result.diagnoses.push({ code: stop });
            break;
        }
        const candidate = node_path_1.default.join(teamsRoot, name);
        try {
            if (!node_fs_1.default.statSync(candidate).isDirectory())
                continue;
        }
        catch {
            result.diagnoses.push({ code: "team_unreadable", teamName: name });
            continue;
        }
        const team = await readTeam(candidate, name, options, deadline);
        if (team.stop) {
            result.diagnoses.push({ code: team.stop });
            break;
        }
        if (team.team)
            result.teams.push(team.team);
        result.diagnoses.push(...team.diagnoses);
    }
    return result;
}
