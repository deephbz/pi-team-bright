import { hostEnv, type DurableFileHandle } from "../env/host-env";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomicAsync } from "./atomic-json";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import type { TeamConfig, Member, TerminalTarget, LogicalWorker } from "../team-authority/contracts";
import { assertTerminalTargetShape } from "./terminal-target";
import { configPath, leadSessionPath, sanitizeName, teamDir, taskDir, PI_DIR, TEAMS_DIR } from "./paths";
import * as paths from "./paths";
import { withLock } from "./lock";
import { normalizeTeamPaneLayout, type TeamPaneLayout } from "./team-pane-layout";
import { THINKING_LEVELS } from "../team-authority/contracts";
import { applyMembershipPatch, parseMembership, transitionMembership, type CarrierLaunchKind, type MembershipEvent, type MembershipRefusal, type MembershipTransition, type StopAuthority } from "../team-authority/membership-machine";

function malformedConfigError(configFile: string, detail: string): Error {
  return new Error(`Team config ${configFile} is malformed (${detail}); refusing to overwrite it. Restore the file or move it aside only after reviewing its contents.`);
}

function validateConfigShape(value: Record<string, unknown>, configFile: string): void {
  if (value.name !== undefined && typeof value.name !== "string") throw malformedConfigError(configFile, "name must be a string");
  if (value.epochId !== undefined && (typeof value.epochId !== "string" || !value.epochId)) {
    throw malformedConfigError(configFile, "epochId must be a non-empty string");
  }
  if (value.implementationVersion !== undefined && (typeof value.implementationVersion !== "string" || !value.implementationVersion)) {
    throw malformedConfigError(configFile, "implementationVersion must be a non-empty string");
  }
  if (value.logicalWorkers !== undefined && !Array.isArray(value.logicalWorkers)) {
    throw malformedConfigError(configFile, "logicalWorkers must be an array");
  }
  if (Array.isArray(value.logicalWorkers)) {
    const names = new Set<string>();
    for (const [index, rawWorker] of value.logicalWorkers.entries()) {
      if (!rawWorker || typeof rawWorker !== "object" || Array.isArray(rawWorker)) {
        throw malformedConfigError(configFile, `logicalWorkers[${index}] must be an object`);
      }
      const worker = rawWorker as Partial<LogicalWorker>;
      if (typeof worker.name !== "string" || !worker.name || typeof worker.scope !== "string" || !worker.scope.trim()) {
        throw malformedConfigError(configFile, `logicalWorkers[${index}] requires non-empty name and scope strings`);
      }
      if (worker.modelProfile !== undefined) {
        const profile = worker.modelProfile;
        if (!profile || typeof profile !== "object" || typeof profile.provider !== "string" || !profile.provider.trim() || profile.provider.includes("/") || typeof profile.model !== "string" || !profile.model.trim() || (profile.thinking !== undefined && !THINKING_LEVELS.includes(profile.thinking as any)) || (profile.alias !== undefined && (typeof profile.alias !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(profile.alias)))) {
          throw malformedConfigError(configFile, `logicalWorkers[${index}].modelProfile is invalid`);
        }
      }
      try {
        sanitizeName(worker.name);
      } catch (error) {
        throw malformedConfigError(configFile, error instanceof Error ? error.message : String(error));
      }
      if (names.has(worker.name)) throw malformedConfigError(configFile, `logicalWorkers contains duplicate name ${worker.name}`);
      names.add(worker.name);
    }
  }
  if (value.members !== undefined && !Array.isArray(value.members)) throw malformedConfigError(configFile, "members must be an array");
  if (value.terminalBackend !== undefined && (typeof value.terminalBackend !== "string" || !value.terminalBackend)) {
    throw malformedConfigError(configFile, "terminalBackend must be a non-empty string");
  }
  if (value.paneLayout !== undefined) {
    try {
      normalizeTeamPaneLayout(value.paneLayout, typeof value.terminalBackend === "string" ? value.terminalBackend : undefined);
    } catch (error) {
      throw malformedConfigError(configFile, error instanceof Error ? error.message : String(error));
    }
  }
  if (Array.isArray(value.members)) {
    for (const [index, rawMember] of value.members.entries()) {
      if (!rawMember || typeof rawMember !== "object" || Array.isArray(rawMember)) {
        throw malformedConfigError(configFile, `members[${index}] must be an object`);
      }
      const member = rawMember as Partial<Member>;
      if (member.modelProfile !== undefined) {
        const profile = member.modelProfile;
        if (!profile || typeof profile !== "object" || typeof profile.provider !== "string" || !profile.provider.trim() || profile.provider.includes("/") || typeof profile.model !== "string" || !profile.model.trim() || (profile.alias !== undefined && (typeof profile.alias !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(profile.alias))) || (profile.thinking !== undefined && !THINKING_LEVELS.includes(profile.thinking as any))) {
          throw malformedConfigError(configFile, `members[${index}].modelProfile is invalid`);
        }
      }
      if (member.terminalTarget !== undefined) {
        try {
          assertTerminalTargetShape(member.terminalTarget, `members[${index}].terminalTarget`);
        } catch (error) {
          throw malformedConfigError(configFile, error instanceof Error ? error.message : String(error));
        }
        if (member.tmuxPaneId || member.windowId) {
          throw malformedConfigError(configFile, `members[${index}] cannot combine terminalTarget with legacy terminal fields`);
        }
        if (member.isActive !== false && !value.terminalBackend) {
          throw malformedConfigError(configFile, `current members[${index}].terminalTarget requires terminalBackend`);
        }
        if (member.isActive !== false && member.terminalTarget.backend !== value.terminalBackend) {
          throw malformedConfigError(configFile, `current members[${index}].terminalTarget backend must match terminalBackend`);
        }
      }
      if (member.tmuxPaneId && member.windowId) {
        throw malformedConfigError(configFile, `members[${index}] cannot contain both legacy pane and window targets`);
      }
    }
  }
}

export function teamExists(teamName: string) {
  return fs.existsSync(configPath(teamName));
}

export function newMembershipId(): string {
  return `membership_${hostEnv().random.uuid()}`;
}

export function newLaunchId(): string {
  return `launch_${hostEnv().random.uuid()}`;
}

export function newTeamEpochId(): string {
  return `team_epoch_${hostEnv().random.uuid()}`;
}

/** 600 lock attempts at 100 ms each: bounded to one minute. */
export const TEAM_TOPOLOGY_LEASE_RETRIES = 600;

export interface TeamTopologyLease {
  readonly teamName: string;
}

const activeTopologyLeases = new WeakSet<TeamTopologyLease>();

function teamTopologyLeasePath(teamName: string): string {
  // Validate the public identity, then keep coordination records outside the
  // Team directory so probing a missing Team does not create Team state.
  const safeName = sanitizeName(teamName);
  const identity = crypto.createHash("sha256").update(safeName).digest("hex");
  return path.join(PI_DIR, "team-topology-leases", identity);
}

/**
 * Serialize lifecycle/topology transactions for one Team. Callers must take
 * exact Membership leases only inside this lease, preserving the global order
 * topology -> Membership -> TeamConfig. Different Teams remain independent.
 */
export async function withTeamTopologyLease<T>(
  teamName: string,
  action: (lease: TeamTopologyLease) => Promise<T>,
  options: { retries?: number } = {},
): Promise<T> {
  const safeName = sanitizeName(teamName);
  return withLock(teamTopologyLeasePath(safeName), async () => {
    const lease: TeamTopologyLease = { teamName: safeName };
    activeTopologyLeases.add(lease);
    try {
      return await action(lease);
    } finally {
      activeTopologyLeases.delete(lease);
    }
  }, options.retries ?? TEAM_TOPOLOGY_LEASE_RETRIES);
}

function assertTopologyLease(teamName: string, lease: TeamTopologyLease): void {
  const safeName = sanitizeName(teamName);
  if (!activeTopologyLeases.has(lease) || lease.teamName !== safeName) {
    throw new Error(`Invalid or inactive topology lease for team ${safeName}.`);
  }
}

export interface TeamTerminalBinding {
  backend: string;
  leadTarget?: TerminalTarget;
}

export async function createTeam(
  name: string,
  sessionId: string,
  leadAgentId: string,
  description = "",
  defaultModel?: string,
  separateWindows?: boolean,
  topologyLease?: TeamTopologyLease,
  terminalBinding?: TeamTerminalBinding,
  implementationVersion?: string,
  paneLayout?: TeamPaneLayout,
  syncLiveness?: TeamConfig["syncLiveness"],
): Promise<TeamConfig> {
  if (!topologyLease) {
    return withTeamTopologyLease(name, (lease) => createTeam(
      name,
      sessionId,
      leadAgentId,
      description,
      defaultModel,
      separateWindows,
      lease,
      terminalBinding,
      implementationVersion,
      paneLayout,
      syncLiveness,
    ));
  }
  assertTopologyLease(name, topologyLease);
  if (paneLayout) {
    try {
      paneLayout = normalizeTeamPaneLayout(paneLayout, terminalBinding?.backend);
    } catch (error) {
      throw new Error(`Invalid Team pane layout: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (terminalBinding && (!terminalBinding.backend || typeof terminalBinding.backend !== "string")) {
    throw new Error("Team terminal binding requires a non-empty backend.");
  }
  if (terminalBinding?.leadTarget && terminalBinding.leadTarget.backend !== terminalBinding.backend) {
    throw new Error(`Lead terminal target uses ${terminalBinding.leadTarget.backend}, but Team ${name} is being bound to ${terminalBinding.backend}.`);
  }
  if (terminalBinding?.leadTarget) assertTerminalTargetShape(terminalBinding.leadTarget, "Lead terminal target");
  const dir = teamDir(name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const priorConfigPath = configPath(name);
  return withLock(priorConfigPath, async () => {
  const graph = new DurableGraphTaskAuthority();
  let priorMembers: Member[] = [];
  let priorLogicalWorkers: LogicalWorker[] | undefined;
  if (fs.existsSync(priorConfigPath)) {
    const prior = readConfigRaw(priorConfigPath);
    const currentMembers = prior.members.filter((member) => member.isActive !== false);
    if (currentMembers.length > 0) {
      throw new Error(
        `Team ${name} still has current Memberships (${currentMembers.map((member) => member.name).join(", ")}); ` +
        "run team_shutdown from its current lead before recreating the Team. team_create never implicitly stops processes or replaces live identities.",
      );
    }
    priorMembers = structuredClone(prior.members);
    priorLogicalWorkers = prior.logicalWorkers === undefined ? undefined : structuredClone(prior.logicalWorkers);
    await graph.readTasks(name);
  } else {
    await graph.initializeEmpty(name);
  }

  const leadMember: Member = {
    membershipId: newMembershipId(),
    agentId: leadAgentId,
    name: "team-lead",
    agentType: "lead",
    joinedAt: hostEnv().clock.now(),
    ...(terminalBinding?.leadTarget ? { terminalTarget: structuredClone(terminalBinding.leadTarget) } : {}),
    cwd: hostEnv().process.cwd(),
    subscriptions: [],
    isActive: true,
    ...(sessionId ? { sessionFile: sessionId } : {}),
  };

  const config: TeamConfig = {
    name,
    description,
    createdAt: hostEnv().clock.now(),
    leadAgentId,
    leadSessionId: sessionId,
    epochId: newTeamEpochId(),
    ...(implementationVersion ? { implementationVersion } : {}),
    logicalWorkers: priorLogicalWorkers ?? [],
    members: [...priorMembers, leadMember],
    ...(terminalBinding ? { terminalBackend: terminalBinding.backend } : {}),
    defaultModel,
    separateWindows,
    ...(paneLayout ? { paneLayout } : {}),
    ...(syncLiveness ? { syncLiveness: structuredClone(syncLiveness) } : {}),
  };

  await writeJsonAtomicAsync(configPath(name), config);
  return config;
  });
}

function parseConfigRaw(p: string, raw: string): TeamConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw malformedConfigError(p, error instanceof Error ? error.message : String(error));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedConfigError(p, "expected a JSON object");
  }
  validateConfigShape(value as Record<string, unknown>, p);
  return value as TeamConfig;
}

function readConfigRaw(p: string): TeamConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch (error) {
    throw malformedConfigError(p, error instanceof Error ? error.message : String(error));
  }
  return parseConfigRaw(p, raw);
}

async function readConfigRawAsync(p: string): Promise<TeamConfig> {
  let raw: string;
  let handle: DurableFileHandle | undefined;
  try {
    handle = await hostEnv().durableFs.open(p, "r");
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    raw = buffer.subarray(0, offset).toString("utf-8");
  } catch (error) {
    throw malformedConfigError(p, error instanceof Error ? error.message : String(error));
  } finally {
    try { await handle?.close(); } catch {}
  }
  return parseConfigRaw(p, raw);
}

// TeamConfig replacement uses the shared durable JSON writer.

/** Find the team this durable Pi Session leads. */
export function findLeadTeamForSession(piSessionFile?: string): string | null {
  const teamsDir = paths.TEAMS_DIR;
  if (!fs.existsSync(teamsDir)) return null;

  const sessionMatches: string[] = [];
  for (const teamDir of fs.readdirSync(teamsDir)) {
    try {
      const recordPath = paths.configPath(teamDir);
      if (!fs.existsSync(recordPath)) continue;
      const config = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as {
        members?: Member[];
      };
      const lead = [...(config.members || [])].reverse().find(
        (member) => member.name === "team-lead" && member.isActive !== false,
      );
      if (piSessionFile && lead?.sessionFile === piSessionFile) sessionMatches.push(teamDir);
    } catch {
      // Ignore corrupted session files.
    }
  }

  if (sessionMatches.length > 1) {
    throw new Error(
      `Ambiguous lead Session binding: this durable Pi Session is registered to multiple teams (${sessionMatches.join(", ")}). ` +
      "Refusing to choose by filesystem order. Set PI_TEAM_NAME to the intended current team before resuming, or repair the stale lead-session records.",
    );
  }
  if (sessionMatches.length === 1) return sessionMatches[0];
  return null;
}

/**
 * Locate a teammate by the Pi session file it registered on first startup.
 * Session files survive a new process launched with `pi -r`, unlike PIDs and
 * terminal pane IDs. Invalid or incomplete foreign team records are ignored
 * during discovery; their owning operation will surface a precise error.
 */
export function findTeammateBySessionFile(sessionFile: string): { teamName: string; member: Member } | null {
  if (!sessionFile || !fs.existsSync(TEAMS_DIR)) return null;

  const matches: Array<{ teamName: string; member: Member }> = [];
  for (const teamName of fs.readdirSync(TEAMS_DIR)) {
    try {
      const configFile = configPath(teamName);
      if (!fs.existsSync(configFile)) continue;
      const config = readConfigRaw(configFile);
      const member = [...config.members].reverse().find(candidate =>
        candidate.agentType === "teammate" && candidate.isActive !== false && candidate.sessionFile === sessionFile
      );
      if (member) matches.push({ teamName, member });
    } catch {
      // One malformed or concurrently removed team must not block other resumes.
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous teammate Session binding: ${sessionFile} is current in multiple teams (${matches.map((match) => match.teamName).join(", ")}); refusing filesystem-order selection.`,
    );
  }
  return matches[0] ?? null;
}

/** Discovery reads stable Membership identity before validating Team-specific policy. */
function configHasCurrentSession(file: string, sessionFile: string): boolean {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedConfigError(file, "Session discovery requires a config object");
  }
  const record = value as Record<string, unknown>;
  const members = record.members === undefined ? [] : record.members;
  if (!Array.isArray(members)) throw malformedConfigError(file, "members must be an array");
  let matches = false;
  for (const raw of members) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw malformedConfigError(file, "Session discovery requires Membership objects");
    }
    const member = raw as Record<string, unknown>;
    if (member.isActive !== undefined && typeof member.isActive !== "boolean") {
      throw malformedConfigError(file, "Membership isActive must be a boolean");
    }
    if (member.isActive === false) continue;
    if (member.sessionFile !== undefined && typeof member.sessionFile !== "string") {
      throw malformedConfigError(file, "Membership sessionFile must be a string");
    }
    if (member.sessionFile === sessionFile) matches = true;
  }
  return matches;
}

export type CurrentLeadSessionBindingResolution =
  | { status: "bound"; teamName: string; member: Member }
  | {
      status: "abstain";
      reason: "not_bound" | "ambiguous_binding" | "runtime_metadata_unavailable" | "stale_binding";
    };

/**
 * Resolve one current lead Membership by exact durable Pi Session identity.
 * A strict scan and locked revalidation prevent filesystem order, names,
 * processes, terminal carriers, or a concurrently replaced epoch from binding.
 */
export async function resolveCurrentLeadSessionBinding(
  sessionFile: string,
): Promise<CurrentLeadSessionBindingResolution> {
  if (!sessionFile || !fs.existsSync(TEAMS_DIR)) return { status: "abstain", reason: "not_bound" };

  const exact: Array<{ teamName: string; member: Member; epochId?: string }> = [];
  try {
    for (const teamName of fs.readdirSync(TEAMS_DIR)) {
      const file = configPath(teamName);
      if (!fs.existsSync(file)) continue;
      if (!configHasCurrentSession(file, sessionFile)) continue;
      const config = readConfigRaw(file);
      for (const member of config.members) {
        if (
          member.isActive !== false
          && member.agentType === "lead"
          && member.name === "team-lead"
          && member.sessionFile === sessionFile
        ) {
          exact.push({ teamName, member: structuredClone(member), epochId: config.epochId });
        }
      }
    }
  } catch {
    return { status: "abstain", reason: "runtime_metadata_unavailable" };
  }
  if (exact.length === 0) return { status: "abstain", reason: "not_bound" };
  if (exact.length !== 1) return { status: "abstain", reason: "ambiguous_binding" };

  const candidate = exact[0];
  try {
    return await withCurrentConfig(candidate.teamName, async (config) => {
      const current = [...config.members].reverse().find((member) =>
        member.isActive !== false
        && member.agentType === "lead"
        && member.name === "team-lead"
        && member.sessionFile === sessionFile
      );
      if (
        !current
        || config.epochId !== candidate.epochId
        || (candidate.member.membershipId !== undefined && current.membershipId !== candidate.member.membershipId)
      ) {
        return { status: "abstain" as const, reason: "stale_binding" as const };
      }
      return {
        status: "bound" as const,
        teamName: candidate.teamName,
        member: structuredClone(current),
      };
    });
  } catch {
    return { status: "abstain", reason: "runtime_metadata_unavailable" };
  }
}

export type CurrentTeammateSessionBindingResolution =
  | { status: "bound"; teamName: string; member: Member }
  | {
      status: "abstain";
      reason:
        | "not_bound"
        | "leader_or_non_teammate"
        | "unverified_generation"
        | "ambiguous_binding"
        | "runtime_metadata_unavailable"
        | "stale_binding";
    };

/**
 * Resolve an operation-specific exact teammate binding without using names,
 * environment, process, pane, or launch metadata. A strict scan refuses to
 * claim uniqueness when Membership identity is unreadable, then the winning
 * Membership generation is revalidated under its mutation and config locks.
 */
export async function resolveCurrentTeammateSessionBinding(
  sessionFile: string,
): Promise<CurrentTeammateSessionBindingResolution> {
  if (!sessionFile || !fs.existsSync(TEAMS_DIR))
    return { status: "abstain", reason: "not_bound" };

  const exact: Array<{ teamName: string; member: Member }> = [];
  try {
    for (const teamName of fs.readdirSync(TEAMS_DIR)) {
      const file = configPath(teamName);
      if (!fs.existsSync(file)) continue;
      if (!configHasCurrentSession(file, sessionFile)) continue;
      const config = readConfigRaw(file);
      for (const member of config.members) {
        if (member.isActive === false || member.sessionFile !== sessionFile)
          continue;
        exact.push({ teamName, member: structuredClone(member) });
      }
    }
  } catch {
    return { status: "abstain", reason: "runtime_metadata_unavailable" };
  }
  if (exact.length === 0) return { status: "abstain", reason: "not_bound" };
  if (exact.length !== 1)
    return { status: "abstain", reason: "ambiguous_binding" };
  const candidate = exact[0];
  if (
    candidate.member.agentType !== "teammate" ||
    candidate.member.name === "team-lead"
  )
    return { status: "abstain", reason: "leader_or_non_teammate" };
  if (!candidate.member.membershipId)
    return { status: "abstain", reason: "unverified_generation" };

  try {
    return await withMembershipMutationLease(
      candidate.teamName,
      candidate.member.membershipId,
      async () =>
        withCurrentConfig(candidate.teamName, async (config) => {
          const current = config.members.find(
            (member) =>
              member.membershipId === candidate.member.membershipId &&
              member.isActive !== false &&
              member.agentType === "teammate" &&
              member.name !== "team-lead" &&
              member.sessionFile === sessionFile,
          );
          return current
            ? {
                status: "bound" as const,
                teamName: candidate.teamName,
                member: structuredClone(current),
              }
            : { status: "abstain" as const, reason: "stale_binding" as const };
        }),
    );
  } catch {
    return { status: "abstain", reason: "runtime_metadata_unavailable" };
  }
}

export async function readConfig(teamName: string): Promise<TeamConfig> {
  const p = configPath(teamName);
  if (!fs.existsSync(p)) {
    throw new Error(`Team ${teamName} not found`);
  }
  return withLock(p, () => readConfigRawAsync(p));
}

/** Hold current membership/config stable across a dependent filesystem write. */
export async function withCurrentConfig<T>(teamName: string, action: (config: TeamConfig) => Promise<T>): Promise<T> {
  const p = configPath(teamName);
  if (!fs.existsSync(p)) throw new Error(`Team ${teamName} not found`);
  return withLock(p, async () => action(readConfigRaw(p)));
}

export type TeamModelToolContractGapReason = "team_epoch_missing" | "logical_workers_missing";

export interface TeamModelToolContractGap {
  kind: "contract_gap";
  reason: TeamModelToolContractGapReason;
}

/** Legacy TeamConfig remains readable, but model-tool state cannot infer missing authority coordinates. */
export function teamModelToolContractGap(config: TeamConfig): TeamModelToolContractGap | undefined {
  if (!config.epochId) return { kind: "contract_gap", reason: "team_epoch_missing" };
  if (!config.logicalWorkers) return { kind: "contract_gap", reason: "logical_workers_missing" };
  return undefined;
}

export type ReadLogicalWorkerResult =
  | { kind: "found"; worker: LogicalWorker }
  | { kind: "not_found" }
  | TeamModelToolContractGap;

/** Read one stable logical Worker without consulting Membership or carrier state. */
export async function readLogicalWorker(teamName: string, workerName: string): Promise<ReadLogicalWorkerResult> {
  sanitizeName(workerName);
  return withCurrentConfig(teamName, async (config) => {
    const gap = teamModelToolContractGap(config);
    if (gap) return gap;
    const worker = config.logicalWorkers!.find((candidate) => candidate.name === workerName);
    return worker ? { kind: "found", worker: structuredClone(worker) } : { kind: "not_found" };
  });
}

export type EnsureLogicalWorkerResult =
  | { kind: "created"; worker: LogicalWorker }
  | { kind: "reused"; worker: LogicalWorker }
  | { kind: "scope_conflict"; worker: LogicalWorker }
  | TeamModelToolContractGap;

/**
 * Ensure durable Worker meaning under the TeamConfig lock. This operation does
 * not create, replace, inspect, or otherwise mutate Membership/carrier state.
 */
export async function ensureLogicalWorker(
  teamName: string,
  input: LogicalWorker,
): Promise<EnsureLogicalWorkerResult> {
  sanitizeName(input.name);
  if (typeof input.scope !== "string" || !input.scope.trim()) {
    throw new Error("Logical Worker scope must be a non-empty string.");
  }
  if (input.modelProfile && (!input.modelProfile.provider.trim() || input.modelProfile.provider.includes("/") || !input.modelProfile.model.trim() || (input.modelProfile.alias !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(input.modelProfile.alias)) || (input.modelProfile.thinking !== undefined && !THINKING_LEVELS.includes(input.modelProfile.thinking as any)))) {
    throw new Error("Logical Worker modelProfile is invalid.");
  }
  const p = configPath(teamName);
  if (!fs.existsSync(p)) throw new Error(`Team ${teamName} not found`);
  return withLock(p, async () => {
    const config = readConfigRaw(p);
    const gap = teamModelToolContractGap(config);
    if (gap) return gap;
    const existing = config.logicalWorkers!.find((worker) => worker.name === input.name);
    if (existing) {
      const worker = structuredClone(existing);
      const sameProfile = input.modelProfile === undefined
        || JSON.stringify(existing.modelProfile ?? null) === JSON.stringify(input.modelProfile);
      return existing.scope === input.scope && sameProfile
        ? { kind: "reused", worker }
        : { kind: "scope_conflict", worker };
    }
    const worker = structuredClone(input);
    config.logicalWorkers!.push(worker);
    await writeJsonAtomicAsync(p, config);
    return { kind: "created", worker: structuredClone(worker) };
  });
}

/** 600 lock attempts at 100 ms each: bounded to one minute. */
export const MEMBERSHIP_MUTATION_LEASE_RETRIES = 600;

function membershipMutationLeasePath(teamName: string, membershipId: string): string {
  if (!membershipId) throw new Error("A Membership identity is required for a mutation lease.");
  const directory = path.join(teamDir(teamName), "membership-mutation-leases");
  fs.mkdirSync(directory, { recursive: true });
  const identity = crypto.createHash("sha256").update(membershipId).digest("hex");
  return path.join(directory, identity);
}

/**
 * Serialize authority mutation and lifecycle transition for one exact
 * Membership generation without blocking unrelated team members. The lease
 * heartbeat is maintained by withLock, so a slow but live backend operation
 * cannot be mistaken for an abandoned writer.
 */
export async function withMembershipMutationLease<T>(
  teamName: string,
  membershipId: string,
  action: () => Promise<T>,
  options: { retries?: number } = {},
): Promise<T> {
  return withLock(
    membershipMutationLeasePath(teamName, membershipId),
    action,
    options.retries ?? MEMBERSHIP_MUTATION_LEASE_RETRIES,
  );
}

export class StaleSessionBindingError extends Error {}

/**
 * Hold one exact Membership generation's mutation lease, briefly revalidate
 * its Session binding under the TeamConfig lock, then release TeamConfig
 * before the external authority operation. Replacement and shutdown acquire
 * the same Membership lease, so no stale write can cross a generation while
 * unrelated members remain concurrent.
 */
export async function withCurrentSessionBinding<T>(
  teamName: string,
  agentName: string,
  sessionFile: string,
  expectedMembershipId: string,
  action: (config: TeamConfig, member: Member) => Promise<T>,
): Promise<T> {
  if (!sessionFile || !expectedMembershipId) throw new StaleSessionBindingError("An exact Membership and durable Pi Session are required for a team-scoped mutation.");
  return withMembershipMutationLease(teamName, expectedMembershipId, async () => {
    const binding = await withCurrentConfig(teamName, async (config) => {
      const member = [...config.members].reverse().find((candidate) => candidate.name === agentName && candidate.isActive !== false);
      if (!member || member.membershipId !== expectedMembershipId || member.sessionFile !== sessionFile) {
        throw new StaleSessionBindingError(`Membership ${expectedMembershipId} / Session ${sessionFile} is not the current binding for ${agentName} on team ${teamName}; stale processes cannot mutate authority state.`);
      }
      return {
        config: structuredClone(config),
        member: structuredClone(member),
      };
    });
    return action(binding.config, binding.member);
  });
}

/**
 * Acquire the exact generation lease used by Task mutation, then verify that
 * generation is still current before a terminal/lifecycle side effect.
 */
export async function withCurrentMembershipLease<T>(
  teamName: string,
  membershipId: string,
  action: (member: Member) => Promise<T>,
): Promise<T> {
  return withMembershipMutationLease(teamName, membershipId, async () => {
    const member = await withCurrentConfig(teamName, async (config) => {
      const current = config.members.find((candidate) => candidate.membershipId === membershipId && candidate.isActive !== false);
      if (!current) throw new Error(`Membership ${membershipId} is no longer current in team ${teamName}.`);
      return structuredClone(current);
    });
    return action(member);
  });
}

export async function currentMembership(teamName: string, agentName: string): Promise<Member> {
  const config = await readConfig(teamName);
  const member = [...config.members].reverse().find((candidate) => candidate.name === agentName && candidate.isActive !== false);
  if (!member) throw new Error(`Agent ${agentName} is not a current member of team ${teamName}.`);
  if (!member.membershipId) {
    throw new Error(`Current Membership for ${agentName} on team ${teamName} has no membershipId; stop the team and respawn it with the current PiTeams version.`);
  }
  return structuredClone(member);
}

export async function bindMemberSession(
  teamName: string,
  agentName: string,
  sessionFile: string,
  launchId?: string,
  updates: Pick<Partial<Member>, "terminalTarget" | "tmuxPaneId" | "windowId"> = {},
  expectedMembershipId?: string,
): Promise<Member> {
  if (!sessionFile) throw new Error("A durable Pi Session file is required for Membership binding.");
  const p = configPath(teamName);
  return withLock(p, async () => {
    const config = readConfigRaw(p);
    const member = [...config.members].reverse().find((candidate) => candidate.name === agentName && candidate.isActive !== false);
    if (!member) throw new Error(`Agent ${agentName} is not a current member of team ${teamName}.`);
    if (!member.membershipId) {
      throw new Error(`Current Membership for ${agentName} on team ${teamName} has no membershipId; stop the team and respawn it.`);
    }
    if (expectedMembershipId && member.membershipId !== expectedMembershipId) {
      throw new Error(
        `Membership ${expectedMembershipId} is no longer the current generation for ${agentName} on team ${teamName}; ` +
        "refusing to bind a replacement Membership from a stale startup.",
      );
    }
    const placement = Object.keys(updates).length ? updates : undefined;
    const step = transitionMembership(parseMembership(member), { type: "bind_session", sessionFile, launchId, at: hostEnv().clock.now(), placement });
    if (step.kind === "refused") throw new Error(membershipRefusalMessage(step.reason, { teamName, member, sessionFile }));
    if (step.kind === "unchanged") return structuredClone(member);
    return commitMembershipStep(p, config, member, step);
  });
}

/** Thrown when the Membership machine refuses an event. The record is unchanged. */
export class MembershipTransitionRefused extends Error {
  constructor(readonly reason: MembershipRefusal, message: string) { super(message); }
}

function membershipRefusalMessage(reason: MembershipRefusal, context: { teamName: string; member: Member; sessionFile?: string }): string {
  const { teamName, member, sessionFile } = context;
  switch (reason) {
    case "launch_capability_consumed": return `Launch capability for ${member.name} has already been consumed; resume by exact Session binding without a launch ID.`;
    case "session_conflict": return `Session ${sessionFile} cannot replace current binding ${member.sessionFile} for ${member.name} on team ${teamName}.`;
    case "launch_capability_mismatch": return `A matching pending launch capability is required for the first Session binding of ${member.name} on team ${teamName}.`;
    case "superseded_launch": return "Launch target belongs to a superseded launch. Inspect the orphan pane.";
    case "launch_in_flight": return `Membership ${member.membershipId} of ${member.name} has a launch that may still start a process.`;
    case "process_may_exist": return `Cannot stop ${member.name}: this Membership has no terminal binding and no exact Membership-bound runtime record proves the process exited. The Membership remains current.`;
    case "invalid_membership": return `Current Membership for ${member.name} on team ${teamName} is invalid; stop the team and respawn it.`;
    case "not_current": return `Membership ${member.membershipId} is not current in team ${teamName}.`;
  }
}

function commitMembershipStep(p: string, config: TeamConfig, member: Member, step: Extract<MembershipTransition, { kind: "applied" }>): Promise<Member> {
  if (step.patch.terminalTarget) {
    assertTerminalTargetShape(step.patch.terminalTarget, "Membership terminal target");
    if (!config.terminalBackend || step.patch.terminalTarget.backend !== config.terminalBackend) {
      throw new Error(`Terminal target backend ${step.patch.terminalTarget.backend} does not match Team ${config.name} backend ${config.terminalBackend || "<missing>"}.`);
    }
  }
  const next = applyMembershipPatch(member, step.patch);
  config.members[config.members.indexOf(member)] = next;
  return writeJsonAtomicAsync(p, config).then(() => structuredClone(next));
}

/**
 * The single writer of Membership lifecycle fields. Unchanged steps write
 * nothing; refusals throw MembershipTransitionRefused and write nothing.
 */
export async function applyMembershipEvent(teamName: string, membershipId: string, event: MembershipEvent): Promise<{ member: Member; changed: boolean }> {
  const p = configPath(teamName);
  return withLock(p, async () => {
    const config = readConfigRaw(p);
    const member = config.members.find((candidate) => candidate.membershipId === membershipId && candidate.isActive !== false);
    if (!member) throw new MembershipTransitionRefused("not_current", `Membership ${membershipId} is not current in team ${teamName}.`);
    const step = transitionMembership(parseMembership(member), event);
    if (step.kind === "refused") throw new MembershipTransitionRefused(step.reason, membershipRefusalMessage(step.reason, { teamName, member }));
    if (step.kind === "unchanged") return { member: structuredClone(member), changed: false };
    return { member: await commitMembershipStep(p, config, member, step), changed: true };
  });
}

export async function assertCurrentSessionBinding(teamName: string, agentName: string, sessionFile: string): Promise<Member> {
  if (!sessionFile) throw new Error("A durable Pi Session file is required for a team-scoped mutation.");
  const config = await readConfig(teamName);
  const member = [...config.members].reverse().find((candidate) => candidate.name === agentName && candidate.isActive !== false);
  if (!member) throw new Error(`Agent ${agentName} is not a current member of team ${teamName}.`);
  const bound = member.sessionFile;
  if (!bound || bound !== sessionFile) {
    throw new Error(`Session ${sessionFile} is not the current binding for ${agentName} on team ${teamName}; fork/stale Sessions cannot mutate team state.`);
  }
  return structuredClone(member);
}

export async function addMember(teamName: string, member: Member) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    const next = structuredClone(member);
    if (next.name === "team-lead" || next.agentType === "lead") {
      throw new Error("'team-lead' and lead Memberships are reserved for team creation.");
    }
    next.membershipId ||= newMembershipId();
    if (next.isActive !== false && next.agentType === "teammate") {
      if (!!next.sessionFile === !!next.pendingLaunchId) {
        throw new Error(`Current teammate Membership ${next.membershipId} must be exactly one of launch-prepared or Session-bound.`);
      }
    }
    if (next.terminalTarget) {
      assertTerminalTargetShape(next.terminalTarget, "Membership terminal target");
      if (!config.terminalBackend || next.terminalTarget.backend !== config.terminalBackend) {
        throw new Error(`Terminal target backend ${next.terminalTarget.backend} does not match Team ${teamName} backend ${config.terminalBackend || "<missing>"}.`);
      }
    }
    if (config.members.some((candidate) => candidate.membershipId === next.membershipId)) {
      throw new Error(`Duplicate membershipId ${next.membershipId} in team ${teamName}.`);
    }
    if (config.members.some((candidate) => candidate.name === next.name && candidate.isActive !== false)) {
      throw new Error(`A current member named ${next.name} already exists in team ${teamName}.`);
    }
    const workerLimit = config.paneLayout?.worker_limit;
    const activeWorkers = config.members.filter((candidate) => candidate.agentType === "teammate" && candidate.isActive !== false).length;
    if (next.isActive !== false && next.agentType === "teammate"
      && workerLimit !== undefined && activeWorkers >= workerLimit) {
      throw new Error(`Team Worker limit ${workerLimit} has been reached; stop a current Worker before ensuring another.`);
    }
    config.members.push(next);
    await writeJsonAtomicAsync(p, config);
  });
}

/**
 * Deactivate exactly one Membership generation; never resolve by reusable name.
 * The caller names the evidence that authorizes the stop; the machine checks it.
 */
export async function deactivateMembership(
  teamName: string,
  membershipId: string,
  reason: NonNullable<Member["deactivationReason"]>,
  authority: { authority: StopAuthority; carrier: CarrierLaunchKind },
): Promise<Member | null> {
  try {
    return (await applyMembershipEvent(teamName, membershipId, { type: "deactivate", reason, at: hostEnv().clock.now(), ...authority })).member;
  } catch (error) {
    if (error instanceof MembershipTransitionRefused && error.reason === "not_current") return null;
    throw error;
  }
}

