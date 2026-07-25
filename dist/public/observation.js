"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.observationJsonSchema = exports.OBSERVATION_PRODUCER_VERSION = exports.OBSERVATION_SCHEMA_VERSION = exports.OBSERVATION_SCHEMA = void 0;
exports.readObservationSnapshot = readObservationSnapshot;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const package_json_1 = __importDefault(require("../../package.json"));
const runtime_1 = require("../utils/runtime");
exports.OBSERVATION_SCHEMA = "pi-teams-observation/1";
exports.OBSERVATION_SCHEMA_VERSION = 1;
exports.OBSERVATION_PRODUCER_VERSION = package_json_1.default.version;
const issueCodes = ["teams_root_unavailable", "team_unreadable", "team_config_missing", "team_config_malformed", "membership_malformed", "membership_duplicate", "session_locator_invalid", "runtime_missing", "runtime_malformed", "runtime_legacy", "runtime_generation_mismatch", "runtime_unavailable", "process_binding_ambiguous", "team_changed_during_read", "projection_deadline_exceeded", "projection_aborted"];
const issueSchema = { oneOf: [
        { type: "object", additionalProperties: false, required: ["code", "scope"], properties: { code: { enum: ["teams_root_unavailable", "projection_deadline_exceeded", "projection_aborted"] }, scope: { const: "snapshot" } } },
        { type: "object", additionalProperties: false, required: ["code", "scope", "teamName"], properties: { code: { enum: ["team_unreadable", "team_config_missing", "team_config_malformed", "membership_malformed", "team_changed_during_read"] }, scope: { const: "team" }, teamName: { type: "string", minLength: 1 } } },
        { type: "object", additionalProperties: false, required: ["code", "scope", "teamName", "memberName", "membershipId"], properties: { code: { enum: issueCodes.filter(code => !["teams_root_unavailable", "projection_deadline_exceeded", "projection_aborted", "team_unreadable", "team_config_missing", "team_config_malformed", "membership_malformed", "team_changed_during_read"].includes(code)) }, scope: { const: "membership" }, teamName: { type: "string", minLength: 1 }, memberName: { type: "string", minLength: 1 }, membershipId: { type: "string", minLength: 1 } } },
    ] };
/** Canonical JSON Schema for the local, evidence-only pi-teams-observation/1 wire record. */
exports.observationJsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: exports.OBSERVATION_SCHEMA, type: "object", additionalProperties: false,
    required: ["schema", "generatedAt", "producerVersion", "availability", "teams", "issues"],
    properties: { schema: { const: exports.OBSERVATION_SCHEMA }, generatedAt: { type: "string", format: "date-time" }, producerVersion: { type: "string", minLength: 1 }, availability: { enum: ["available", "partial", "unavailable"] }, teams: { type: "array", items: { $ref: "#/$defs/team" } }, issues: { type: "array", items: { $ref: "#/$defs/issue" } } },
    $defs: {
        issue: issueSchema,
        terminalTarget: { type: "object", additionalProperties: false, required: ["backend", "kind", "targetId"], properties: { backend: { type: "string", minLength: 1 }, kind: { enum: ["pane", "window"] }, targetId: { type: "string", minLength: 1 } } },
        lifecycle: { oneOf: [
                { type: "object", additionalProperties: false, required: ["state", "joinedAt"], properties: { state: { const: "current" }, joinedAt: { type: "string", format: "date-time" } } },
                { type: "object", additionalProperties: false, required: ["state", "joinedAt"], properties: { state: { const: "ended" }, joinedAt: { type: "string", format: "date-time" }, endedAt: { type: "string", format: "date-time" }, reason: { enum: ["team_shutdown", "process_shutdown", "replaced"] } } },
            ] },
        session: { type: "object", additionalProperties: false, required: ["kind", "locator"], properties: { kind: { const: "pi-jsonl-path" }, locator: { type: "string", minLength: 1, pattern: "^/" } } },
        processBinding: { type: "object", additionalProperties: false, required: ["membershipId", "pid", "processStartedAt"], properties: { membershipId: { type: "string", minLength: 1 }, pid: { type: "integer", minimum: 2 }, processStartedAt: { type: "string", format: "date-time" } } },
        membership: { type: "object", additionalProperties: false, required: ["membershipId", "teamName", "memberName", "coordinationRole", "lifecycle", "issues"], properties: { membershipId: { type: "string", minLength: 1 }, teamName: { type: "string", minLength: 1 }, memberName: { type: "string", minLength: 1 }, coordinationRole: { enum: ["lead", "teammate"] }, lifecycle: { $ref: "#/$defs/lifecycle" }, session: { $ref: "#/$defs/session" }, terminalTarget: { $ref: "#/$defs/terminalTarget" }, processBinding: { $ref: "#/$defs/processBinding" }, readiness: { type: "boolean" }, issues: { type: "array", items: { $ref: "#/$defs/issue" } } } },
        team: { type: "object", additionalProperties: false, required: ["teamName", "memberships", "issues"], properties: { teamName: { type: "string", minLength: 1 }, memberships: { type: "array", items: { $ref: "#/$defs/membership" } }, issues: { type: "array", items: { $ref: "#/$defs/issue" } } } },
    },
};
function snapshotIssue(code = "teams_root_unavailable") { return { code, scope: "snapshot" }; }
function teamIssue(code, teamName) { return { code, scope: "team", teamName }; }
function membershipIssue(code, member, teamName) { return { code, scope: "membership", teamName, memberName: member.name, membershipId: member.membershipId }; }
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
function projectMember(teamName, candidate, duplicateIds, ambiguousBindings) {
    const { member, runtime, runtimeState } = candidate;
    const issues = [];
    const joinedAt = iso(member.joinedAt);
    const endedAt = iso(member.deactivatedAt);
    const lifecycle = member.isActive === false ? { state: "ended", joinedAt, ...(endedAt ? { endedAt } : {}), ...(member.deactivationReason ? { reason: member.deactivationReason } : {}) } : { state: "current", joinedAt };
    const projected = { membershipId: member.membershipId, teamName, memberName: member.name, coordinationRole: member.agentType === "lead" ? "lead" : "teammate", lifecycle, issues, ...(validTarget(member.terminalTarget) ? { terminalTarget: member.terminalTarget } : {}) };
    if (absoluteLocator(member.sessionFile))
        projected.session = { kind: "pi-jsonl-path", locator: member.sessionFile };
    else if (validString(member.sessionFile))
        issues.push(membershipIssue("session_locator_invalid", member, teamName));
    if (duplicateIds.has(member.membershipId))
        issues.push(membershipIssue("membership_duplicate", member, teamName));
    if (runtimeState === "missing")
        issues.push(membershipIssue("runtime_missing", member, teamName));
    if (runtimeState === "malformed")
        issues.push(membershipIssue("runtime_malformed", member, teamName));
    if (runtimeState === "unavailable")
        issues.push(membershipIssue("runtime_unavailable", member, teamName));
    const generation = runtime ? (0, runtime_1.runtimeGeneration)(runtime) : null;
    const startedAt = generation && iso(generation.startedAt);
    const generationValid = !!runtime && !!generation && !!startedAt && runtime.membershipId === member.membershipId && !duplicateIds.has(member.membershipId) && !ambiguousBindings.has(member.membershipId);
    if (runtime) {
        if (!runtime.membershipId || !generation || !startedAt)
            issues.push(membershipIssue("runtime_legacy", member, teamName));
        else if (runtime.membershipId !== member.membershipId)
            issues.push(membershipIssue("runtime_generation_mismatch", member, teamName));
        else if (ambiguousBindings.has(member.membershipId))
            issues.push(membershipIssue("process_binding_ambiguous", member, teamName));
    }
    if (generationValid) {
        projected.processBinding = { membershipId: generation.membershipId, pid: generation.pid, processStartedAt: startedAt };
        if (typeof runtime.ready === "boolean")
            projected.readiness = runtime.ready;
    }
    return projected;
}
const yieldRead = () => new Promise(resolve => setImmediate(resolve));
function readControl(options) {
    const deadline = Date.now() + Math.max(0, options.deadlineMs ?? 1_000);
    return { expired: () => options.signal?.aborted ? snapshotIssue("projection_aborted") : Date.now() >= deadline ? snapshotIssue("projection_deadline_exceeded") : undefined };
}
async function projectConfig(config, directory, control) {
    const candidates = [];
    const teamIssues = [];
    for (const raw of config.members) {
        await yieldRead();
        if (control.expired())
            return control.expired();
        if (!memberIsUsable(raw)) {
            teamIssues.push(teamIssue("membership_malformed", config.name));
            continue;
        }
        const runtimeFile = node_path_1.default.join(directory, "runtime", `${raw.name}.json`);
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
    for (const candidate of candidates)
        counts.set(candidate.member.membershipId, (counts.get(candidate.member.membershipId) ?? 0) + 1);
    const duplicateIds = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
    const bindings = new Map();
    for (const candidate of candidates) {
        const generation = candidate.runtime && (0, runtime_1.runtimeGeneration)(candidate.runtime);
        const startedAt = generation && iso(generation.startedAt);
        if (candidate.member.isActive !== false && generation && startedAt && generation.membershipId === candidate.member.membershipId && !duplicateIds.has(candidate.member.membershipId)) {
            const key = `${generation.pid}:${startedAt}`;
            bindings.set(key, [...(bindings.get(key) ?? []), candidate.member.membershipId]);
        }
    }
    const ambiguous = new Set([...bindings.values()].filter(ids => ids.length > 1).flat());
    return { teamName: config.name, memberships: candidates.map(candidate => projectMember(config.name, candidate, duplicateIds, ambiguous)), issues: teamIssues };
}
async function readTeam(directory, directoryName, control) {
    const configFile = node_path_1.default.join(directory, "config.json");
    for (let attempt = 0; attempt < 2; attempt++) {
        const stop = control.expired();
        if (stop)
            return { issues: [], stop };
        let before;
        try {
            before = node_fs_1.default.readFileSync(configFile, "utf8");
        }
        catch {
            return { issues: [teamIssue(node_fs_1.default.existsSync(configFile) ? "team_config_malformed" : "team_config_missing", directoryName)] };
        }
        let config;
        try {
            const parsed = JSON.parse(before);
            if (!configIsUsable(parsed))
                throw new Error("shape");
            config = parsed;
        }
        catch {
            return { issues: [teamIssue("team_config_malformed", directoryName)] };
        }
        const projected = await projectConfig(config, directory, control);
        if (!("memberships" in projected))
            return { issues: [], stop: projected };
        const afterStop = control.expired();
        if (afterStop)
            return { issues: [], stop: afterStop };
        try {
            if (node_fs_1.default.readFileSync(configFile, "utf8") === before)
                return { team: projected, issues: [] };
        }
        catch {
            return { issues: [teamIssue("team_unreadable", directoryName)] };
        }
        if (attempt === 1)
            return { issues: [teamIssue("team_changed_during_read", config.name)] };
    }
    return { issues: [teamIssue("team_changed_during_read", directoryName)] };
}
/** Lock-free, read-only evidence projection. Atomic producers provide old-or-new records. */
async function readObservationSnapshot(options = {}) {
    const teamsRoot = options.teamsRoot ?? node_path_1.default.join(node_os_1.default.homedir(), ".pi", "teams");
    const control = readControl(options);
    const snapshot = { schema: exports.OBSERVATION_SCHEMA, generatedAt: new Date().toISOString(), producerVersion: options.producerVersion ?? exports.OBSERVATION_PRODUCER_VERSION, availability: "available", teams: [], issues: [] };
    const initialStop = control.expired();
    if (initialStop) {
        snapshot.availability = "unavailable";
        snapshot.issues.push(initialStop);
        return snapshot;
    }
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(teamsRoot);
    }
    catch {
        snapshot.availability = "unavailable";
        snapshot.issues.push(snapshotIssue());
        return snapshot;
    }
    for (const name of entries.sort()) {
        await yieldRead();
        const stop = control.expired();
        if (stop) {
            snapshot.issues.push(stop);
            break;
        }
        const candidate = node_path_1.default.join(teamsRoot, name);
        try {
            if (!node_fs_1.default.statSync(candidate).isDirectory())
                continue;
        }
        catch {
            snapshot.issues.push(teamIssue("team_unreadable", name));
            continue;
        }
        const result = await readTeam(candidate, name, control);
        if (result.stop) {
            snapshot.issues.push(result.stop);
            break;
        }
        if (result.team)
            snapshot.teams.push(result.team);
        snapshot.issues.push(...result.issues);
    }
    if (snapshot.issues.length || snapshot.teams.some(team => team.issues.length || team.memberships.some(member => member.issues.length)))
        snapshot.availability = snapshot.teams.length ? "partial" : "unavailable";
    return snapshot;
}
