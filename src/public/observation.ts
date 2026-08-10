import packageJson from "../../package.json";
import { readMembershipObservation, type MembershipObservationDiagnosisCode, type MembershipObservationEvidence, type TeamObservationDiagnosisCode } from "../team-authority/membership-observation-reader";

export const OBSERVATION_SCHEMA = "pi-teams-observation/1" as const;
export const OBSERVATION_SCHEMA_VERSION = 1 as const;
export const OBSERVATION_PRODUCER_VERSION = packageJson.version;

export type ObservationAvailability = "available" | "partial" | "unavailable";
export type SnapshotIssueCode = "teams_root_unavailable" | "projection_deadline_exceeded" | "projection_aborted";
export type TeamIssueCode = "team_unreadable" | "team_config_missing" | "team_config_malformed" | "membership_malformed" | "team_changed_during_read";
export type MembershipIssueCode = "membership_duplicate" | "session_locator_invalid" | "runtime_missing" | "runtime_malformed" | "runtime_legacy" | "runtime_generation_mismatch" | "runtime_unavailable" | "process_binding_ambiguous";
export type ObservationIssueCode = SnapshotIssueCode | TeamIssueCode | MembershipIssueCode;
export type ObservationIssue =
  | { code: SnapshotIssueCode; scope: "snapshot" }
  | { code: TeamIssueCode; scope: "team"; teamName: string }
  | { code: MembershipIssueCode; scope: "membership"; teamName: string; memberName: string; membershipId: string };

export interface MembershipObservation {
  membershipId: string;
  teamName: string;
  memberName: string;
  coordinationRole: "lead" | "teammate";
  lifecycle: { state: "current"; joinedAt: string } | { state: "ended"; joinedAt: string; endedAt?: string; reason?: "team_shutdown" | "process_shutdown" | "replaced" };
  session?: { kind: "pi-jsonl-path"; locator: string };
  terminalTarget?: { backend: string; kind: "pane" | "window"; targetId: string };
  processBinding?: { membershipId: string; pid: number; processStartedAt: string };
  /** Recorded readiness, not an liveness assertion. Present only with a valid exact generation. */
  readiness?: boolean;
  issues: ObservationIssue[];
}
export interface TeamObservation { teamName: string; memberships: MembershipObservation[]; issues: ObservationIssue[]; }
export interface TeamObservationSnapshot { schema: typeof OBSERVATION_SCHEMA; generatedAt: string; producerVersion: string; availability: ObservationAvailability; teams: TeamObservation[]; issues: ObservationIssue[]; }

const issueCodes: ObservationIssueCode[] = ["teams_root_unavailable", "team_unreadable", "team_config_missing", "team_config_malformed", "membership_malformed", "membership_duplicate", "session_locator_invalid", "runtime_missing", "runtime_malformed", "runtime_legacy", "runtime_generation_mismatch", "runtime_unavailable", "process_binding_ambiguous", "team_changed_during_read", "projection_deadline_exceeded", "projection_aborted"];
const issueSchema = { oneOf: [
  { type: "object", additionalProperties: false, required: ["code", "scope"], properties: { code: { enum: ["teams_root_unavailable", "projection_deadline_exceeded", "projection_aborted"] }, scope: { const: "snapshot" } } },
  { type: "object", additionalProperties: false, required: ["code", "scope", "teamName"], properties: { code: { enum: ["team_unreadable", "team_config_missing", "team_config_malformed", "membership_malformed", "team_changed_during_read"] }, scope: { const: "team" }, teamName: { type: "string", minLength: 1 } } },
  { type: "object", additionalProperties: false, required: ["code", "scope", "teamName", "memberName", "membershipId"], properties: { code: { enum: issueCodes.filter(code => !["teams_root_unavailable", "projection_deadline_exceeded", "projection_aborted", "team_unreadable", "team_config_missing", "team_config_malformed", "membership_malformed", "team_changed_during_read"].includes(code)) }, scope: { const: "membership" }, teamName: { type: "string", minLength: 1 }, memberName: { type: "string", minLength: 1 }, membershipId: { type: "string", minLength: 1 } } },
] };

/** Canonical JSON Schema for the local, evidence-only pi-teams-observation/1 wire record. */
export const observationJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: OBSERVATION_SCHEMA, type: "object", additionalProperties: false,
  required: ["schema", "generatedAt", "producerVersion", "availability", "teams", "issues"],
  properties: { schema: { const: OBSERVATION_SCHEMA }, generatedAt: { type: "string", format: "date-time" }, producerVersion: { type: "string", minLength: 1 }, availability: { enum: ["available", "partial", "unavailable"] }, teams: { type: "array", items: { $ref: "#/$defs/team" } }, issues: { type: "array", items: { $ref: "#/$defs/issue" } } },
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
} as const;

export interface ReadObservationOptions { teamsRoot?: string; producerVersion?: string; /** Total projection budget; defaults to 1 second. */ deadlineMs?: number; signal?: AbortSignal; }
function membershipIssue(code: MembershipObservationDiagnosisCode, member: MembershipObservationEvidence, teamName: string): ObservationIssue { return { code, scope: "membership", teamName, memberName: member.memberName, membershipId: member.membershipId }; }
function projectMember(teamName: string, member: MembershipObservationEvidence): MembershipObservation {
  return { membershipId: member.membershipId, teamName, memberName: member.memberName, coordinationRole: member.coordinationRole, lifecycle: member.lifecycle as MembershipObservation["lifecycle"], issues: member.diagnoses.map(code => membershipIssue(code, member, teamName)),  ...(member.sessionLocator ? { session: { kind: "pi-jsonl-path" as const, locator: member.sessionLocator } } : {}), ...(member.terminalTarget ? { terminalTarget: member.terminalTarget } : {}), ...(member.processBinding ? { processBinding: member.processBinding } : {}), ...(typeof member.readiness === "boolean" ? { readiness: member.readiness } : {}) };
}
function teamIssue(code: TeamObservationDiagnosisCode, teamName: string): ObservationIssue { return { code, scope: "team", teamName }; }

/** Lock-free, read-only evidence projection. Atomic producers provide old-or-new records. */
export async function readObservationSnapshot(options: ReadObservationOptions = {}): Promise<TeamObservationSnapshot> {
  const read = await readMembershipObservation(options);
  const teams = read.teams.map(team => ({ teamName: team.teamName, memberships: team.memberships.map(member => projectMember(team.teamName, member)), issues: team.diagnoses.map(code => teamIssue(code, team.teamName)) }));
  const issues: ObservationIssue[] = read.diagnoses.map(diagnosis => "teamName" in diagnosis ? teamIssue(diagnosis.code, diagnosis.teamName) : { code: diagnosis.code, scope: "snapshot" });
  const snapshot: TeamObservationSnapshot = { schema: OBSERVATION_SCHEMA, generatedAt: new Date().toISOString(), producerVersion: options.producerVersion ?? OBSERVATION_PRODUCER_VERSION, availability: "available", teams, issues };
  if (snapshot.issues.length || snapshot.teams.some(team => team.issues.length || team.memberships.some(member => member.issues.length))) snapshot.availability = snapshot.teams.length ? "partial" : "unavailable";
  return snapshot;
}
