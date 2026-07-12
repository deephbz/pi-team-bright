import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TeamConfig, Member } from "./models";
import { configPath, teamDir, taskDir } from "./paths";
import { withLock } from "./lock";

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

function malformedConfigError(configFile: string, detail: string): Error {
  return new Error(`Team config ${configFile} is malformed (${detail}); refusing to overwrite it. Restore the file or move it aside only after reviewing its contents.`);
}

function validateConfigShape(value: Record<string, unknown>, configFile: string): void {
  if (value.name !== undefined && typeof value.name !== "string") throw malformedConfigError(configFile, "name must be a string");
  if (value.members !== undefined && !Array.isArray(value.members)) throw malformedConfigError(configFile, "members must be an array");
  if (value.taskBackend !== undefined && value.taskBackend !== "legacy" && value.taskBackend !== "beads") {
    throw malformedConfigError(configFile, "taskBackend must be legacy or beads");
  }
  if (value.taskWorkspace !== undefined && typeof value.taskWorkspace !== "string") {
    throw malformedConfigError(configFile, "taskWorkspace must be a string");
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

export function createTeam(
  name: string,
  sessionId: string,
  leadAgentId: string,
  description = "",
  defaultModel?: string,
  separateWindows?: boolean
): TeamConfig {
  const dir = teamDir(name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const priorConfigPath = configPath(name);
  let priorAuthority: Pick<TeamConfig, "taskBackend" | "taskWorkspace" | "taskCutover"> = {};
  if (fs.existsSync(priorConfigPath)) {
    const prior = readConfigRaw(priorConfigPath);
    const cutoverEvidence = findCutoverEvidence(name);
    if (cutoverEvidence && prior.taskBackend !== "beads") {
      throw new Error(`Team ${name} has a ${cutoverEvidence.marker.state} Beads cutover marker at ${cutoverEvidence.markerPath}, but its config is not Beads-authoritative; refusing to reconnect the team to legacy tasks. Restore the Beads TeamConfig or complete an explicit recovery review.`);
    }
    if (prior.taskBackend === "beads") {
      if (!prior.taskWorkspace) {
        throw new Error(`Team ${name} is marked Beads-authoritative but has no taskWorkspace; refusing to recreate it against legacy tasks. Restore the original TeamConfig and Beads workspace.`);
      }
      priorAuthority = {
        taskBackend: prior.taskBackend,
        taskWorkspace: prior.taskWorkspace,
        taskCutover: prior.taskCutover,
      };
    }
  } else {
    const cutoverEvidence = findCutoverEvidence(name);
    if (cutoverEvidence) {
      throw new Error(`Team ${name} config is missing, but ${cutoverEvidence.marker.state} Beads cutover evidence exists at ${cutoverEvidence.markerPath}; refusing to initialize legacy authority. Restore config.json from backup or perform an explicit Beads recovery review.`);
    }
  }

  const tasksDir = taskDir(name);
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });

  const leadMember: Member = {
    agentId: leadAgentId,
    name: "team-lead",
    agentType: "lead",
    joinedAt: Date.now(),
    tmuxPaneId: process.env.TMUX_PANE || "",
    cwd: process.cwd(),
    subscriptions: [],
  };

  const config: TeamConfig = {
    name,
    description,
    createdAt: Date.now(),
    leadAgentId,
    leadSessionId: sessionId,
    members: [leadMember],
    defaultModel,
    separateWindows,
    ...priorAuthority,
  };

  writeConfigAtomic(configPath(name), config);
  return config;
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

export async function addMember(teamName: string, member: Member) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    config.members.push(member);
    writeConfigAtomic(p, config);
  });
}

export async function removeMember(teamName: string, agentName: string) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    config.members = config.members.filter(m => m.name !== agentName);
    writeConfigAtomic(p, config);
  });
}

export async function updateMember(teamName: string, agentName: string, updates: Partial<Member>) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    const m = config.members.find(m => m.name === agentName);
    if (m) {
      Object.assign(m, updates);
      writeConfigAtomic(p, config);
    }
  });
}

export async function configureBeadsTaskBackend(
  teamName: string,
  taskWorkspace: string,
  taskCutover: NonNullable<TeamConfig["taskCutover"]>,
): Promise<TeamConfig> {
  const p = configPath(teamName);
  if (!fs.existsSync(p)) throw new Error(`Team ${teamName} not found`);
  return await withLock(p, async () => {
    const config = readConfigRaw(p);
    if (config.taskBackend === "beads" && config.taskWorkspace && config.taskWorkspace !== taskWorkspace) {
      throw new Error(`Team ${teamName} is already cut over to Beads workspace ${config.taskWorkspace}; refusing to switch authority silently.`);
    }
    config.taskBackend = "beads";
    config.taskWorkspace = taskWorkspace;
    config.taskCutover = taskCutover;
    writeConfigAtomic(p, config);
    return config;
  });
}
