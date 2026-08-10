import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Private, read-only decoder for recorded Team and runtime evidence. */
export type MembershipObservationDiagnosisCode =
  | "membership_duplicate" | "session_locator_invalid" | "runtime_missing" | "runtime_malformed"
  | "runtime_legacy" | "runtime_generation_mismatch" | "runtime_unavailable" | "process_binding_ambiguous";
export type TeamObservationDiagnosisCode = "team_unreadable" | "team_config_missing" | "team_config_malformed" | "membership_malformed" | "team_changed_during_read";
export type SnapshotObservationDiagnosisCode = "teams_root_unavailable" | "projection_deadline_exceeded" | "projection_aborted";
export type MembershipObservationEvidence = {
  membershipId: string;
  memberName: string;
  coordinationRole: "lead" | "teammate";
  lifecycle: { state: "current"; joinedAt: string } | { state: "ended"; joinedAt: string; endedAt?: string; reason?: unknown };
  sessionLocator?: string;
  terminalTarget?: { backend: string; kind: "pane" | "window"; targetId: string };
  processBinding?: { membershipId: string; pid: number; processStartedAt: string };
  readiness?: boolean;
  diagnoses: MembershipObservationDiagnosisCode[];
};
export type TeamObservationEvidence = { teamName: string; memberships: MembershipObservationEvidence[]; diagnoses: TeamObservationDiagnosisCode[] };
export type MembershipObservationRead = { teams: TeamObservationEvidence[]; diagnoses: Array<{ code: SnapshotObservationDiagnosisCode } | { code: TeamObservationDiagnosisCode; teamName: string }> };
export interface ReadMembershipObservationOptions { teamsRoot?: string; deadlineMs?: number; signal?: AbortSignal; }

type RuntimeState = "missing" | "malformed" | "unavailable" | "present";
type RuntimeEvidence = { membershipId?: unknown; pid?: unknown; startedAt?: unknown; ready?: unknown };
type Candidate = { member: Record<string, unknown>; runtime: RuntimeEvidence | null; runtimeState: RuntimeState };
const TEAM_CONFIG_FILENAME = "config.json";
const RUNTIME_DIRECTORY = "runtime";
const yieldRead = () => new Promise<void>(resolve => setImmediate(resolve));

function iso(value: unknown): string | undefined { const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN; try { return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined; } catch { return undefined; } }
function validString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function safeName(value: unknown): value is string { return validString(value) && /^[a-zA-Z0-9_-]+$/.test(value); }
function validTarget(value: unknown): value is { backend: string; kind: "pane" | "window"; targetId: string } { return !!value && typeof value === "object" && validString((value as Record<string, unknown>).backend) && ((value as Record<string, unknown>).kind === "pane" || (value as Record<string, unknown>).kind === "window") && validString((value as Record<string, unknown>).targetId); }
function absoluteLocator(value: unknown): value is string { return validString(value) && path.isAbsolute(value) && path.normalize(value) === value; }
function parseObject(file: string): unknown { return JSON.parse(fs.readFileSync(file, "utf8")); }
function configIsUsable(value: unknown): value is { name: string; members: unknown[] } { return !!value && typeof value === "object" && validString((value as Record<string, unknown>).name) && Array.isArray((value as Record<string, unknown>).members); }
function memberIsUsable(member: unknown): member is Record<string, unknown> { return !!member && typeof member === "object" && validString((member as Record<string, unknown>).membershipId) && safeName((member as Record<string, unknown>).name) && ((member as Record<string, unknown>).agentType === "lead" || (member as Record<string, unknown>).agentType === "teammate") && !!iso((member as Record<string, unknown>).joinedAt); }
function generation(runtime: RuntimeEvidence | null): { membershipId: unknown; pid: number; startedAt: unknown } | undefined { const pid = runtime?.pid; const startedAt = runtime?.startedAt; return runtime && !!runtime.membershipId && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0 ? { membershipId: runtime.membershipId, pid, startedAt } : undefined; }
function expired(options: ReadMembershipObservationOptions, deadline: number): SnapshotObservationDiagnosisCode | undefined { return options.signal?.aborted ? "projection_aborted" : Date.now() >= deadline ? "projection_deadline_exceeded" : undefined; }

function projectMember(teamName: string, candidate: Candidate, duplicateIds: Set<string>, ambiguousBindings: Set<string>): MembershipObservationEvidence {
  const { member, runtime, runtimeState } = candidate; const diagnoses: MembershipObservationDiagnosisCode[] = [];
  const membershipId = member.membershipId as string; const memberName = member.name as string; const joinedAt = iso(member.joinedAt)!; const endedAt = iso(member.deactivatedAt);
  const lifecycle = member.isActive === false ? { state: "ended" as const, joinedAt, ...(endedAt ? { endedAt } : {}), ...(member.deactivationReason ? { reason: member.deactivationReason } : {}) } : { state: "current" as const, joinedAt };
  const projected: MembershipObservationEvidence = { membershipId, memberName, coordinationRole: member.agentType === "lead" ? "lead" : "teammate", lifecycle, diagnoses, ...(validTarget(member.terminalTarget) ? { terminalTarget: member.terminalTarget } : {}) };
  if (absoluteLocator(member.sessionFile)) projected.sessionLocator = member.sessionFile;
  else if (validString(member.sessionFile)) diagnoses.push("session_locator_invalid");
  if (duplicateIds.has(membershipId)) diagnoses.push("membership_duplicate");
  if (runtimeState === "missing") diagnoses.push("runtime_missing");
  if (runtimeState === "malformed") diagnoses.push("runtime_malformed");
  if (runtimeState === "unavailable") diagnoses.push("runtime_unavailable");
  const runtimeGeneration = generation(runtime); const startedAt = runtimeGeneration && iso(runtimeGeneration.startedAt);
  const generationValid = !!runtime && !!runtimeGeneration && !!startedAt && runtime.membershipId === membershipId && !duplicateIds.has(membershipId) && !ambiguousBindings.has(membershipId);
  if (runtime) {
    if (!runtime.membershipId || !runtimeGeneration || !startedAt) diagnoses.push("runtime_legacy");
    else if (runtime.membershipId !== membershipId) diagnoses.push("runtime_generation_mismatch");
    else if (ambiguousBindings.has(membershipId)) diagnoses.push("process_binding_ambiguous");
  }
  if (generationValid) { projected.processBinding = { membershipId: runtimeGeneration!.membershipId as string, pid: runtimeGeneration!.pid, processStartedAt: startedAt! }; if (typeof runtime!.ready === "boolean") projected.readiness = runtime!.ready; }
  return projected;
}

async function projectConfig(config: { name: string; members: unknown[] }, directory: string, options: ReadMembershipObservationOptions, deadline: number): Promise<TeamObservationEvidence | SnapshotObservationDiagnosisCode> {
  const candidates: Candidate[] = []; const diagnoses: TeamObservationDiagnosisCode[] = [];
  for (const raw of config.members) {
    await yieldRead(); const stop = expired(options, deadline); if (stop) return stop;
    if (!memberIsUsable(raw)) { diagnoses.push("membership_malformed"); continue; }
    const runtimeFile = path.join(directory, RUNTIME_DIRECTORY, `${raw.name}.json`); let runtime: RuntimeEvidence | null = null; let runtimeState: RuntimeState = "missing";
    try { if (fs.existsSync(runtimeFile)) { const parsed = parseObject(runtimeFile); if (!parsed || typeof parsed !== "object") throw new Error("shape"); runtime = parsed as RuntimeEvidence; runtimeState = "present"; } } catch { runtimeState = "malformed"; }
    candidates.push({ member: raw, runtime, runtimeState });
  }
  const counts = new Map<string, number>(); for (const candidate of candidates) { const id = candidate.member.membershipId as string; counts.set(id, (counts.get(id) ?? 0) + 1); }
  const duplicateIds = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id)); const bindings = new Map<string, string[]>();
  for (const candidate of candidates) { const runtimeGeneration = generation(candidate.runtime); const startedAt = runtimeGeneration && iso(runtimeGeneration.startedAt); const id = candidate.member.membershipId as string; if (candidate.member.isActive !== false && runtimeGeneration && startedAt && runtimeGeneration.membershipId === id && !duplicateIds.has(id)) { const key = `${runtimeGeneration.pid}:${startedAt}`; bindings.set(key, [...(bindings.get(key) ?? []), id]); } }
  const ambiguous = new Set([...bindings.values()].filter(ids => ids.length > 1).flat());
  return { teamName: config.name, memberships: candidates.map(candidate => projectMember(config.name, candidate, duplicateIds, ambiguous)), diagnoses };
}

async function readTeam(directory: string, directoryName: string, options: ReadMembershipObservationOptions, deadline: number): Promise<{ team?: TeamObservationEvidence; diagnoses: MembershipObservationRead["diagnoses"]; stop?: SnapshotObservationDiagnosisCode }> {
  const configFile = path.join(directory, TEAM_CONFIG_FILENAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    const stop = expired(options, deadline); if (stop) return { diagnoses: [], stop };
    let before: string; try { before = fs.readFileSync(configFile, "utf8"); } catch { return { diagnoses: [{ code: fs.existsSync(configFile) ? "team_config_malformed" : "team_config_missing", teamName: directoryName }] }; }
    let config: { name: string; members: unknown[] }; try { const parsed = JSON.parse(before); if (!configIsUsable(parsed)) throw new Error("shape"); config = parsed; } catch { return { diagnoses: [{ code: "team_config_malformed", teamName: directoryName }] }; }
    const projected = await projectConfig(config, directory, options, deadline); if (typeof projected === "string") return { diagnoses: [], stop: projected };
    const afterStop = expired(options, deadline); if (afterStop) return { diagnoses: [], stop: afterStop };
    try { if (fs.readFileSync(configFile, "utf8") === before) return { team: projected, diagnoses: [] }; } catch { return { diagnoses: [{ code: "team_unreadable", teamName: directoryName }] }; }
    if (attempt === 1) return { diagnoses: [{ code: "team_changed_during_read", teamName: config.name }] };
  }
  return { diagnoses: [{ code: "team_changed_during_read", teamName: directoryName }] };
}

/** Read lock-free recorded Membership evidence. This module never writes Team or runtime records. */
export async function readMembershipObservation(options: ReadMembershipObservationOptions = {}): Promise<MembershipObservationRead> {
  const teamsRoot = options.teamsRoot ?? path.join(os.homedir(), ".pi", "teams"); const deadline = Date.now() + Math.max(0, options.deadlineMs ?? 1_000); const result: MembershipObservationRead = { teams: [], diagnoses: [] };
  const initialStop = expired(options, deadline); if (initialStop) { result.diagnoses.push({ code: initialStop }); return result; }
  let entries: string[]; try { entries = fs.readdirSync(teamsRoot); } catch { result.diagnoses.push({ code: "teams_root_unavailable" }); return result; }
  for (const name of entries.sort()) {
    await yieldRead(); const stop = expired(options, deadline); if (stop) { result.diagnoses.push({ code: stop }); break; }
    const candidate = path.join(teamsRoot, name); try { if (!fs.statSync(candidate).isDirectory()) continue; } catch { result.diagnoses.push({ code: "team_unreadable", teamName: name }); continue; }
    const team = await readTeam(candidate, name, options, deadline); if (team.stop) { result.diagnoses.push({ code: team.stop }); break; } if (team.team) result.teams.push(team.team); result.diagnoses.push(...team.diagnoses);
  }
  return result;
}
