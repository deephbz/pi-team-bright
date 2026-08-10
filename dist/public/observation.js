"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.observationJsonSchema = exports.OBSERVATION_PRODUCER_VERSION = exports.OBSERVATION_SCHEMA_VERSION = exports.OBSERVATION_SCHEMA = void 0;
exports.readObservationSnapshot = readObservationSnapshot;
const package_json_1 = __importDefault(require("../../package.json"));
const membership_observation_reader_1 = require("../team-authority/membership-observation-reader");
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
function membershipIssue(code, member, teamName) { return { code, scope: "membership", teamName, memberName: member.memberName, membershipId: member.membershipId }; }
function projectMember(teamName, member) {
    return { membershipId: member.membershipId, teamName, memberName: member.memberName, coordinationRole: member.coordinationRole, lifecycle: member.lifecycle, issues: member.diagnoses.map(code => membershipIssue(code, member, teamName)), ...(member.sessionLocator ? { session: { kind: "pi-jsonl-path", locator: member.sessionLocator } } : {}), ...(member.terminalTarget ? { terminalTarget: member.terminalTarget } : {}), ...(member.processBinding ? { processBinding: member.processBinding } : {}), ...(typeof member.readiness === "boolean" ? { readiness: member.readiness } : {}) };
}
function teamIssue(code, teamName) { return { code, scope: "team", teamName }; }
/** Lock-free, read-only evidence projection. Atomic producers provide old-or-new records. */
async function readObservationSnapshot(options = {}) {
    const read = await (0, membership_observation_reader_1.readMembershipObservation)(options);
    const teams = read.teams.map(team => ({ teamName: team.teamName, memberships: team.memberships.map(member => projectMember(team.teamName, member)), issues: team.diagnoses.map(code => teamIssue(code, team.teamName)) }));
    const issues = read.diagnoses.map(diagnosis => "teamName" in diagnosis ? teamIssue(diagnosis.code, diagnosis.teamName) : { code: diagnosis.code, scope: "snapshot" });
    const snapshot = { schema: exports.OBSERVATION_SCHEMA, generatedAt: new Date().toISOString(), producerVersion: options.producerVersion ?? exports.OBSERVATION_PRODUCER_VERSION, availability: "available", teams, issues };
    if (snapshot.issues.length || snapshot.teams.some(team => team.issues.length || team.memberships.some(member => member.issues.length)))
        snapshot.availability = snapshot.teams.length ? "partial" : "unavailable";
    return snapshot;
}
