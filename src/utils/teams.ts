import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BeadsAuthorityFingerprint, TeamConfig, Member, TerminalTarget, LogicalWorker } from "../team-authority/contracts";
import { assertTerminalTargetShape } from "./terminal-target";
import { configPath, leadSessionPath, sanitizeName, teamDir, taskDir, PI_DIR, TEAMS_DIR } from "./paths";
import * as paths from "./paths";
import { withLock } from "./lock";
import { normalizeTeamPaneLayout, type TeamPaneLayout } from "./team-pane-layout";

export interface CutoverMarker {
  state: "prepared" | "active";
  teamName?: string;
  inventoryPath: string;
  inventorySha256: string;
  workspace?: string;
  markerPath?: string;
  cutoverAt?: string;
}

function cutoverMarkerCandidates(teamName: string): string[] {
  const sourceDir = taskDir(teamName);
  const defaultPath = path.join(sourceDir, `.pi-teams-${teamName}-cutover.jsonl`);
  if (!fs.existsSync(sourceDir)) return [defaultPath];

  const additionalPaths = fs.readdirSync(sourceDir)
    .filter(fileName => fileName.endsWith("-cutover.jsonl"))
    .map(fileName => path.join(sourceDir, fileName));
  return [...new Set([defaultPath, ...additionalPaths])];
}

function parseCutoverMarker(markerPath: string): CutoverMarker | undefined {
  if (!fs.existsSync(markerPath)) return undefined;
  let lines: string[];
  try {
    lines = fs.readFileSync(markerPath, "utf8").split("\n").filter(Boolean);
  } catch (error) {
    throw new Error(`Cannot read Beads cutover marker ${markerPath}; refusing to recreate the team until it is restored: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (lines.length === 0) {
    throw new Error(`Beads cutover marker ${markerPath} is empty; refusing to recreate the team until the cutover record is restored.`);
  }

  const events = lines.map((line, index) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`Beads cutover marker ${markerPath} is malformed at line ${index + 1}; refusing to recreate the team until it is restored.`);
    }
    if (!event || typeof event !== "object" || (event.state !== "prepared" && event.state !== "active")) {
      throw new Error(`Beads cutover marker ${markerPath} has an invalid state at line ${index + 1}; refusing to recreate the team.`);
    }
    if (typeof event.inventoryPath !== "string" || !event.inventoryPath || typeof event.inventorySha256 !== "string" || !/^[a-f0-9]{64}$/i.test(event.inventorySha256)) {
      throw new Error(`Beads cutover marker ${markerPath} lacks authenticated inventory evidence at line ${index + 1}; refusing to recreate the team.`);
    }
    if (event.workspace !== undefined && (typeof event.workspace !== "string" || !path.isAbsolute(event.workspace))) {
      throw new Error(`Beads cutover marker ${markerPath} has an invalid workspace at line ${index + 1}; refusing to recreate the team.`);
    }
    return event as unknown as CutoverMarker;
  });
  return events[events.length - 1];
}

/** Read the latest validated event from a migration marker. */
export function readLatestCutoverMarker(markerPath: string): CutoverMarker | undefined {
  return parseCutoverMarker(markerPath);
}

function findCutoverEvidence(teamName: string): { markerPath: string; marker: CutoverMarker } | undefined {
  for (const markerPath of cutoverMarkerCandidates(teamName)) {
    const marker = parseCutoverMarker(markerPath);
    if (marker) return { markerPath, marker };
  }
  return undefined;
}

/** Refuse any new authority initialization when migration evidence outlived TeamConfig. */
export function assertNoOrphanedBeadsCutover(teamName: string): void {
  if (fs.existsSync(configPath(teamName))) return;
  const cutoverEvidence = findCutoverEvidence(teamName);
  if (cutoverEvidence) {
    throw new Error(`Team ${teamName} config is missing, but ${cutoverEvidence.marker.state} Beads cutover evidence exists at ${cutoverEvidence.markerPath}; refusing to initialize a new Task authority. Restore config.json from backup or perform an explicit Beads recovery review.`);
  }
}

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
  if (value.taskBackend !== undefined && value.taskBackend !== "legacy" && value.taskBackend !== "beads") {
    throw malformedConfigError(configFile, "taskBackend must be legacy or beads");
  }
  if (value.taskWorkspace !== undefined && typeof value.taskWorkspace !== "string") {
    throw malformedConfigError(configFile, "taskWorkspace must be a string");
  }
  if (value.taskAuthorityId !== undefined && typeof value.taskAuthorityId !== "string") {
    throw malformedConfigError(configFile, "taskAuthorityId must be a string");
  }
  if (value.taskAuthorityFingerprint !== undefined) {
    const fingerprint = value.taskAuthorityFingerprint as Partial<BeadsAuthorityFingerprint> | null;
    if (
      !fingerprint
      || typeof fingerprint !== "object"
      || fingerprint.schema !== "pi-teams-beads-authority/1"
      || fingerprint.backend !== "dolt"
      || fingerprint.database !== "dolt"
      || typeof fingerprint.doltDatabase !== "string"
      || !fingerprint.doltDatabase
      || typeof fingerprint.projectId !== "string"
      || !fingerprint.projectId
    ) {
      throw malformedConfigError(configFile, "taskAuthorityFingerprint must be a complete pi-teams-beads-authority/1 record");
    }
  }
  if (value.taskCutover !== undefined) {
    const cutover = value.taskCutover;
    if (!cutover || typeof cutover !== "object" || Array.isArray(cutover)) throw malformedConfigError(configFile, "taskCutover must be an object");
    const record = cutover as Record<string, unknown>;
    if (typeof record.inventoryPath !== "string" || typeof record.inventorySha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.inventorySha256) || typeof record.cutoverAt !== "string") {
      throw malformedConfigError(configFile, "taskCutover has invalid inventory evidence");
    }
    if (record.markerPath !== undefined && typeof record.markerPath !== "string") throw malformedConfigError(configFile, "taskCutover.markerPath must be a string");
  }
}

export function teamExists(teamName: string) {
  return fs.existsSync(configPath(teamName));
}

export function newMembershipId(): string {
  return `membership_${crypto.randomUUID()}`;
}

export function newLaunchId(): string {
  return `launch_${crypto.randomUUID()}`;
}

export function newTeamEpochId(): string {
  return `team_epoch_${crypto.randomUUID()}`;
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
  taskWorkspace?: string,
  taskAuthorityId?: string,
  taskAuthorityFingerprint?: BeadsAuthorityFingerprint,
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
      taskWorkspace,
      taskAuthorityId,
      taskAuthorityFingerprint,
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
  if ([taskWorkspace, taskAuthorityId, taskAuthorityFingerprint].filter(Boolean).length !== 0
    && [taskWorkspace, taskAuthorityId, taskAuthorityFingerprint].filter(Boolean).length !== 3) {
    throw new Error("Beads taskWorkspace, taskAuthorityId, and taskAuthorityFingerprint must be configured together.");
  }
  const dir = teamDir(name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const priorConfigPath = configPath(name);
  return withLock(priorConfigPath, async () => {
  let priorAuthority: Pick<TeamConfig, "taskBackend" | "taskWorkspace" | "taskAuthorityId" | "taskAuthorityFingerprint" | "taskCutover"> = {};
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
    const cutoverEvidence = findCutoverEvidence(name);
    if (cutoverEvidence && prior.taskBackend !== "beads") {
      throw new Error(`Team ${name} has a ${cutoverEvidence.marker.state} Beads cutover marker at ${cutoverEvidence.markerPath}, but its config is not Beads-authoritative; refusing to reconnect the team to legacy tasks. Restore the Beads TeamConfig or complete an explicit recovery review.`);
    }
    if (prior.taskBackend === "beads") {
      if (!prior.taskWorkspace) {
        throw new Error(`Team ${name} is marked Beads-authoritative but has no taskWorkspace; refusing to recreate it against legacy tasks. Restore the original TeamConfig and Beads workspace.`);
      }
      if (taskWorkspace && prior.taskWorkspace !== taskWorkspace) {
        throw new Error(`Team ${name} already uses Beads workspace ${prior.taskWorkspace}; refusing to silently switch authority.`);
      }
      if (taskAuthorityId && prior.taskAuthorityId !== taskAuthorityId) {
        throw new Error(`Team ${name} already has a different opaque Task authority identity; refusing to rebind it.`);
      }
      if (taskAuthorityFingerprint && JSON.stringify(prior.taskAuthorityFingerprint) !== JSON.stringify(taskAuthorityFingerprint)) {
        throw new Error(`Team ${name} already has a different external Task authority fingerprint; refusing to rebind it.`);
      }
      priorAuthority = {
        taskBackend: prior.taskBackend,
        taskWorkspace: prior.taskWorkspace,
        taskAuthorityId: prior.taskAuthorityId,
        taskAuthorityFingerprint: prior.taskAuthorityFingerprint,
        taskCutover: prior.taskCutover,
      };
      if (!priorAuthority.taskAuthorityId || !priorAuthority.taskAuthorityFingerprint) {
        throw new Error(`Team ${name} has an incomplete Beads Task authority binding; restore taskAuthorityId and taskAuthorityFingerprint through an explicit recovery review.`);
      }
    } else if (taskWorkspace) {
      throw new Error(`Team ${name} still uses legacy JSON Task authority. Run: npm run migrate:tasks -- ${name} ${taskWorkspace}`);
    }
  } else {
    assertNoOrphanedBeadsCutover(name);
  }

  if (!taskWorkspace) {
    const tasksDir = taskDir(name);
    if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });
  }

  const leadMember: Member = {
    membershipId: newMembershipId(),
    agentId: leadAgentId,
    name: "team-lead",
    agentType: "lead",
    joinedAt: Date.now(),
    ...(terminalBinding?.leadTarget ? { terminalTarget: structuredClone(terminalBinding.leadTarget) } : {}),
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
    ...(sessionId ? { sessionFile: sessionId } : {}),
  };

  const config: TeamConfig = {
    name,
    description,
    createdAt: Date.now(),
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
    ...(taskWorkspace ? { taskBackend: "beads" as const, taskWorkspace, taskAuthorityId, taskAuthorityFingerprint } : {}),
    ...priorAuthority,
  };

  writeConfigAtomic(configPath(name), config);
  return config;
  });
}

function readConfigRaw(p: string): TeamConfig {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (error) {
    throw malformedConfigError(p, error instanceof Error ? error.message : String(error));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedConfigError(p, "expected a JSON object");
  }
  validateConfigShape(value as Record<string, unknown>, p);
  return value as TeamConfig;
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is not available on every supported local filesystem.
  }
}

/** Persist TeamConfig without exposing a truncated target file. */
export function writeConfigAtomic(p: string, config: TeamConfig): void {
  const dir = path.dirname(p);
  const existing = fs.existsSync(p) ? fs.statSync(p) : undefined;
  if (existing && !existing.isFile()) throw new Error(`Cannot replace TeamConfig ${p}: the existing path is not a regular file.`);

  const existingMode = existing ? existing.mode & 0o7777 : 0o600;
  const tempPath = path.join(dir, `.${path.basename(p)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    // Start restrictive even when the eventual replacement must retain a
    // pre-existing mode; the temporary name is never created world-readable.
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(config, null, 2));
    fs.fsyncSync(fd);
    if (existing && existingMode !== 0o600) fs.fchmodSync(fd, existingMode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, p);
    fsyncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the write error.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The rename may have succeeded before a directory fsync failure.
    }
    throw error;
  }
}

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
 * claim uniqueness when any TeamConfig is unreadable, then the winning
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
    const cutoverEvidence = findCutoverEvidence(teamName);
    if (cutoverEvidence) {
      throw new Error(`Team ${teamName} config is missing, but ${cutoverEvidence.marker.state} Beads cutover evidence exists at ${cutoverEvidence.markerPath}; refusing to fall back to legacy tasks. Restore config.json from backup or perform an explicit Beads recovery review.`);
    }
    throw new Error(`Team ${teamName} not found`);
  }
  return await withLock(p, async () => {
    return readConfigRaw(p);
  });
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
  const p = configPath(teamName);
  if (!fs.existsSync(p)) throw new Error(`Team ${teamName} not found`);
  return withLock(p, async () => {
    const config = readConfigRaw(p);
    const gap = teamModelToolContractGap(config);
    if (gap) return gap;
    const existing = config.logicalWorkers!.find((worker) => worker.name === input.name);
    if (existing) {
      const worker = structuredClone(existing);
      return existing.scope === input.scope
        ? { kind: "reused", worker }
        : { kind: "scope_conflict", worker };
    }
    const worker = structuredClone(input);
    config.logicalWorkers!.push(worker);
    writeConfigAtomic(p, config);
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
  if (!sessionFile || !expectedMembershipId) throw new Error("An exact Membership and durable Pi Session are required for a team-scoped mutation.");
  return withMembershipMutationLease(teamName, expectedMembershipId, async () => {
    const binding = await withCurrentConfig(teamName, async (config) => {
      const member = [...config.members].reverse().find((candidate) => candidate.name === agentName && candidate.isActive !== false);
      if (!member || member.membershipId !== expectedMembershipId || member.sessionFile !== sessionFile) {
        throw new Error(`Membership ${expectedMembershipId} / Session ${sessionFile} is not the current binding for ${agentName} on team ${teamName}; stale processes cannot mutate authority state.`);
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
    if (member.sessionFile) {
      if (launchId) throw new Error(`Launch capability for ${agentName} has already been consumed; resume by exact Session binding without a launch ID.`);
      if (member.sessionFile !== sessionFile) {
        throw new Error(`Session ${sessionFile} cannot replace current binding ${member.sessionFile} for ${agentName} on team ${teamName}.`);
      }
    } else {
      if (!launchId || !member.pendingLaunchId || launchId !== member.pendingLaunchId) {
        throw new Error(`A matching pending launch capability is required for the first Session binding of ${agentName} on team ${teamName}.`);
      }
      member.sessionFile = sessionFile;
      member.pendingLaunchId = undefined;
      member.launchConsumedAt = new Date().toISOString();
    }
    if (updates.terminalTarget) {
      assertTerminalTargetShape(updates.terminalTarget, "Membership terminal target");
      if (!config.terminalBackend || updates.terminalTarget.backend !== config.terminalBackend) {
        throw new Error(`Terminal target backend ${updates.terminalTarget.backend} does not match Team ${teamName} backend ${config.terminalBackend || "<missing>"}.`);
      }
    }
    Object.assign(member, updates);
    writeConfigAtomic(p, config);
    return structuredClone(member);
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
    config.members.push(next);
    writeConfigAtomic(p, config);
  });
}

export async function deactivateMember(
  teamName: string,
  agentName: string,
  reason: NonNullable<Member["deactivationReason"]>,
): Promise<Member | null> {
  const p = configPath(teamName);
  return withLock(p, async () => {
    const config = readConfigRaw(p);
    const member = config.members.find((candidate) => candidate.name === agentName && candidate.isActive !== false);
    if (!member) return null;
    member.isActive = false;
    member.deactivatedAt = new Date().toISOString();
    member.deactivationReason = reason;
    writeConfigAtomic(p, config);
    return structuredClone(member);
  });
}

/** Deactivate exactly one Membership generation; never resolve by reusable name. */
export async function deactivateMembership(
  teamName: string,
  membershipId: string,
  reason: NonNullable<Member["deactivationReason"]>,
): Promise<Member | null> {
  const p = configPath(teamName);
  return withLock(p, async () => {
    const config = readConfigRaw(p);
    const member = config.members.find((candidate) => candidate.membershipId === membershipId && candidate.isActive !== false);
    if (!member) return null;
    member.isActive = false;
    member.deactivatedAt = new Date().toISOString();
    member.deactivationReason = reason;
    writeConfigAtomic(p, config);
    return structuredClone(member);
  });
}

export async function deactivateCurrentMembers(
  teamName: string,
  reason: NonNullable<Member["deactivationReason"]>,
): Promise<{ deactivated: Member[]; staleBindings: Member[] }> {
  const p = configPath(teamName);
  return withLock(p, async () => {
    const config = readConfigRaw(p);
    const current = config.members.filter((member) => member.isActive !== false);
    const staleBindings = config.members.filter((member) => member.isActive === false && !!(member.terminalTarget || member.tmuxPaneId || member.windowId));
    const at = new Date().toISOString();
    for (const member of current) {
      member.isActive = false;
      member.deactivatedAt = at;
      member.deactivationReason = reason;
    }
    if (current.length > 0) writeConfigAtomic(p, config);
    return { deactivated: structuredClone(current), staleBindings: structuredClone(staleBindings) };
  });
}

export async function updateMember(teamName: string, agentName: string, updates: Partial<Member>) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    const m = [...config.members].reverse().find(m => m.name === agentName && m.isActive !== false);
    if (m) {
      if (updates.terminalTarget) {
        assertTerminalTargetShape(updates.terminalTarget, "Membership terminal target");
        if (!config.terminalBackend || updates.terminalTarget.backend !== config.terminalBackend) {
          throw new Error(`Terminal target backend ${updates.terminalTarget.backend} does not match Team ${teamName} backend ${config.terminalBackend || "<missing>"}.`);
        }
      }
      Object.assign(m, updates);
      writeConfigAtomic(p, config);
    }
  });
}

export async function updateMembership(teamName: string, membershipId: string, updates: Partial<Member>): Promise<Member> {
  const p = configPath(teamName);
  return withLock(p, async () => {
    const config = readConfigRaw(p);
    const member = config.members.find((candidate) => candidate.membershipId === membershipId && candidate.isActive !== false);
    if (!member) throw new Error(`Membership ${membershipId} is not current in team ${teamName}.`);
    if (updates.terminalTarget) {
      assertTerminalTargetShape(updates.terminalTarget, "Membership terminal target");
      if (!config.terminalBackend || updates.terminalTarget.backend !== config.terminalBackend) {
        throw new Error(`Terminal target backend ${updates.terminalTarget.backend} does not match Team ${teamName} backend ${config.terminalBackend || "<missing>"}.`);
      }
    }
    Object.assign(member, updates);
    writeConfigAtomic(p, config);
    return structuredClone(member);
  });
}

export async function configureBeadsTaskBackend(
  teamName: string,
  taskWorkspace: string,
  taskAuthorityFingerprint: BeadsAuthorityFingerprint,
  taskCutover: NonNullable<TeamConfig["taskCutover"]>,
): Promise<TeamConfig> {
  const p = configPath(teamName);
  if (!fs.existsSync(p)) throw new Error(`Team ${teamName} not found`);
  return await withLock(p, async () => {
    const config = readConfigRaw(p);
    if (config.taskBackend === "beads" && config.taskWorkspace && config.taskWorkspace !== taskWorkspace) {
      throw new Error(`Team ${teamName} is already cut over to Beads workspace ${config.taskWorkspace}; refusing to switch authority silently.`);
    }
    if (config.taskBackend === "beads" && config.taskAuthorityFingerprint
      && JSON.stringify(config.taskAuthorityFingerprint) !== JSON.stringify(taskAuthorityFingerprint)) {
      throw new Error(`Team ${teamName} is already bound to a different Beads authority fingerprint; refusing to switch authority silently.`);
    }
    config.taskBackend = "beads";
    config.taskWorkspace = taskWorkspace;
    config.taskAuthorityId ||= `task_authority_${crypto.randomUUID()}`;
    config.taskAuthorityFingerprint = taskAuthorityFingerprint;
    config.taskCutover = taskCutover;
    writeConfigAtomic(p, config);
    return config;
  });
}
