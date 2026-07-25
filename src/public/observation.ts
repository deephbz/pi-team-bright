import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageJson from "../../package.json";
import { type AgentRuntimeStatus, runtimeGeneration } from "../utils/runtime";
import { type Member, type TeamConfig, type TerminalTarget } from "../utils/models";

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
  terminalTarget?: TerminalTarget;
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
type RuntimeState = "missing" | "malformed" | "unavailable" | "present";
type Candidate = { member: Member; runtime: AgentRuntimeStatus | null; runtimeState: RuntimeState };
function snapshotIssue(code: SnapshotIssueCode = "teams_root_unavailable"): ObservationIssue { return { code, scope: "snapshot" }; }
function teamIssue(code: TeamIssueCode, teamName: string): ObservationIssue { return { code, scope: "team", teamName }; }
function membershipIssue(code: MembershipIssueCode, member: Member, teamName: string): ObservationIssue { return { code, scope: "membership", teamName, memberName: member.name, membershipId: member.membershipId! }; }
function iso(value: unknown): string | undefined { const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN; try { return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined; } catch { return undefined; } }
function validString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function safeName(value: unknown): value is string { return validString(value) && /^[a-zA-Z0-9_-]+$/.test(value); }
function validTarget(value: unknown): value is TerminalTarget { return !!value && typeof value === "object" && validString((value as TerminalTarget).backend) && ((value as TerminalTarget).kind === "pane" || (value as TerminalTarget).kind === "window") && validString((value as TerminalTarget).targetId); }
function absoluteLocator(value: unknown): value is string { return validString(value) && path.isAbsolute(value) && path.normalize(value) === value; }
function parseObject(file: string): unknown { return JSON.parse(fs.readFileSync(file, "utf8")); }
function configIsUsable(value: unknown): value is TeamConfig { return !!value && typeof value === "object" && validString((value as TeamConfig).name) && Array.isArray((value as TeamConfig).members); }
function memberIsUsable(member: unknown): member is Member { return !!member && typeof member === "object" && validString((member as Member).membershipId) && safeName((member as Member).name) && ((member as Member).agentType === "lead" || (member as Member).agentType === "teammate") && !!iso((member as Member).joinedAt); }

function projectMember(teamName: string, candidate: Candidate, duplicateIds: Set<string>, ambiguousBindings: Set<string>): MembershipObservation {
  const { member, runtime, runtimeState } = candidate; const issues: ObservationIssue[] = [];
  const joinedAt = iso(member.joinedAt)!; const endedAt = iso(member.deactivatedAt);
  const lifecycle = member.isActive === false ? { state: "ended" as const, joinedAt, ...(endedAt ? { endedAt } : {}), ...(member.deactivationReason ? { reason: member.deactivationReason } : {}) } : { state: "current" as const, joinedAt };
  const projected: MembershipObservation = { membershipId: member.membershipId!, teamName, memberName: member.name, coordinationRole: member.agentType === "lead" ? "lead" : "teammate", lifecycle, issues, ...(validTarget(member.terminalTarget) ? { terminalTarget: member.terminalTarget } : {}) };
  if (absoluteLocator(member.sessionFile)) projected.session = { kind: "pi-jsonl-path", locator: member.sessionFile };
  else if (validString(member.sessionFile)) issues.push(membershipIssue("session_locator_invalid", member, teamName));
  if (duplicateIds.has(member.membershipId!)) issues.push(membershipIssue("membership_duplicate", member, teamName));
  if (runtimeState === "missing") issues.push(membershipIssue("runtime_missing", member, teamName));
  if (runtimeState === "malformed") issues.push(membershipIssue("runtime_malformed", member, teamName));
  if (runtimeState === "unavailable") issues.push(membershipIssue("runtime_unavailable", member, teamName));
  const generation = runtime ? runtimeGeneration(runtime) : null;
  const startedAt = generation && iso(generation.startedAt);
  const generationValid = !!runtime && !!generation && !!startedAt && runtime.membershipId === member.membershipId && !duplicateIds.has(member.membershipId!) && !ambiguousBindings.has(member.membershipId!);
  if (runtime) {
    if (!runtime.membershipId || !generation || !startedAt) issues.push(membershipIssue("runtime_legacy", member, teamName));
    else if (runtime.membershipId !== member.membershipId) issues.push(membershipIssue("runtime_generation_mismatch", member, teamName));
    else if (ambiguousBindings.has(member.membershipId!)) issues.push(membershipIssue("process_binding_ambiguous", member, teamName));
  }
  if (generationValid) { projected.processBinding = { membershipId: generation!.membershipId, pid: generation!.pid, processStartedAt: startedAt! }; if (typeof runtime!.ready === "boolean") projected.readiness = runtime!.ready; }
  return projected;
}

type ReadControl = { expired(): ObservationIssue | undefined };
const yieldRead = () => new Promise<void>(resolve => setImmediate(resolve));
function readControl(options: ReadObservationOptions): ReadControl {
  const deadline = Date.now() + Math.max(0, options.deadlineMs ?? 1_000);
  return { expired: () => options.signal?.aborted ? snapshotIssue("projection_aborted") : Date.now() >= deadline ? snapshotIssue("projection_deadline_exceeded") : undefined };
}
async function projectConfig(config: TeamConfig, directory: string, control: ReadControl): Promise<TeamObservation | ObservationIssue> {
  const candidates: Candidate[] = []; const teamIssues: ObservationIssue[] = [];
  for (const raw of config.members) {
    await yieldRead();
    if (control.expired()) return control.expired()!;
    if (!memberIsUsable(raw)) { teamIssues.push(teamIssue("membership_malformed", config.name)); continue; }
    const runtimeFile = path.join(directory, "runtime", `${raw.name}.json`); let runtime: AgentRuntimeStatus | null = null; let runtimeState: RuntimeState = "missing";
    try { if (fs.existsSync(runtimeFile)) { const parsed = parseObject(runtimeFile); if (!parsed || typeof parsed !== "object") throw new Error("shape"); runtime = parsed as AgentRuntimeStatus; runtimeState = "present"; } } catch { runtimeState = "malformed"; }
    candidates.push({ member: raw, runtime, runtimeState });
  }
  const counts = new Map<string, number>(); for (const candidate of candidates) counts.set(candidate.member.membershipId!, (counts.get(candidate.member.membershipId!) ?? 0) + 1);
  const duplicateIds = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id)); const bindings = new Map<string, string[]>();
  for (const candidate of candidates) { const generation = candidate.runtime && runtimeGeneration(candidate.runtime); const startedAt = generation && iso(generation.startedAt); if (candidate.member.isActive !== false && generation && startedAt && generation.membershipId === candidate.member.membershipId && !duplicateIds.has(candidate.member.membershipId!)) { const key = `${generation.pid}:${startedAt}`; bindings.set(key, [...(bindings.get(key) ?? []), candidate.member.membershipId!]); } }
  const ambiguous = new Set([...bindings.values()].filter(ids => ids.length > 1).flat());
  return { teamName: config.name, memberships: candidates.map(candidate => projectMember(config.name, candidate, duplicateIds, ambiguous)), issues: teamIssues };
}
async function readTeam(directory: string, directoryName: string, control: ReadControl): Promise<{ team?: TeamObservation; issues: ObservationIssue[]; stop?: ObservationIssue }> {
  const configFile = path.join(directory, "config.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    const stop = control.expired(); if (stop) return { issues: [], stop };
    let before: string; try { before = fs.readFileSync(configFile, "utf8"); } catch { return { issues: [teamIssue(fs.existsSync(configFile) ? "team_config_malformed" : "team_config_missing", directoryName)] }; }
    let config: TeamConfig; try { const parsed = JSON.parse(before); if (!configIsUsable(parsed)) throw new Error("shape"); config = parsed; } catch { return { issues: [teamIssue("team_config_malformed", directoryName)] }; }
    const projected = await projectConfig(config, directory, control); if (!("memberships" in projected)) return { issues: [], stop: projected };
    const afterStop = control.expired(); if (afterStop) return { issues: [], stop: afterStop };
    try { if (fs.readFileSync(configFile, "utf8") === before) return { team: projected, issues: [] }; } catch { return { issues: [teamIssue("team_unreadable", directoryName)] }; }
    if (attempt === 1) return { issues: [teamIssue("team_changed_during_read", config.name)] };
  }
  return { issues: [teamIssue("team_changed_during_read", directoryName)] };
}

/** Lock-free, read-only evidence projection. Atomic producers provide old-or-new records. */
export async function readObservationSnapshot(options: ReadObservationOptions = {}): Promise<TeamObservationSnapshot> {
  const teamsRoot = options.teamsRoot ?? path.join(os.homedir(), ".pi", "teams"); const control = readControl(options);
  const snapshot: TeamObservationSnapshot = { schema: OBSERVATION_SCHEMA, generatedAt: new Date().toISOString(), producerVersion: options.producerVersion ?? OBSERVATION_PRODUCER_VERSION, availability: "available", teams: [], issues: [] };
  const initialStop = control.expired(); if (initialStop) { snapshot.availability = "unavailable"; snapshot.issues.push(initialStop); return snapshot; }
  let entries: string[]; try { entries = fs.readdirSync(teamsRoot); } catch { snapshot.availability = "unavailable"; snapshot.issues.push(snapshotIssue()); return snapshot; }
  for (const name of entries.sort()) { await yieldRead(); const stop = control.expired(); if (stop) { snapshot.issues.push(stop); break; } const candidate = path.join(teamsRoot, name); try { if (!fs.statSync(candidate).isDirectory()) continue; } catch { snapshot.issues.push(teamIssue("team_unreadable", name)); continue; } const result = await readTeam(candidate, name, control); if (result.stop) { snapshot.issues.push(result.stop); break; } if (result.team) snapshot.teams.push(result.team); snapshot.issues.push(...result.issues); }
  if (snapshot.issues.length || snapshot.teams.some(team => team.issues.length || team.memberships.some(member => member.issues.length))) snapshot.availability = snapshot.teams.length ? "partial" : "unavailable";
  return snapshot;
}
