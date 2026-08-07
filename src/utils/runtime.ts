import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { runtimeStatusPath, teamDir } from "./paths";
import type { Member } from "./models";

/**
 * Runtime constants for health checking.
 * Exported for configurability and testing.
 */
export const HEARTBEAT_STALE_MS = 90000; // 90 seconds
export const STARTUP_STALL_MS = 60000;   // 60 seconds
export const RUNTIME_STALE_MS = 300000;  // 5 minutes - files older than this are considered stale

/**
 * Structured error information for better diagnostics.
 */
export interface RuntimeError {
  message: string;
  timestamp: number;
}

export interface AgentRuntimeStatus {
  teamName: string;
  agentName: string;
  membershipId?: string;
  pid?: number;
  startedAt?: number;
  lastHeartbeatAt?: number;
  lastInboxReadAt?: number;
  ready?: boolean;
  /** Exact Pi 0.83 agent lifecycle evidence for the current generation. */
  runState?: "active" | "settled";
  lastError?: RuntimeError;
}

/** Exact ephemeral process generation within one durable Membership. */
export interface RuntimeGeneration {
  membershipId: string;
  pid: number;
  startedAt: number;
}

export function runtimeGeneration(status: AgentRuntimeStatus | null): RuntimeGeneration | null {
  if (
    !status?.membershipId
    || !Number.isSafeInteger(status.pid)
    || status.pid! <= 1
    || !Number.isFinite(status.startedAt)
    || status.startedAt! <= 0
  ) return null;
  return {
    membershipId: status.membershipId,
    pid: status.pid!,
    startedAt: status.startedAt!,
  };
}

/** One current Membership admits one live Pi process generation. */
export type RuntimeStartupAdmission =
  | { kind: "admitted"; action: "claim" | "already_current"; replaces?: RuntimeGeneration }
  | { kind: "refused"; reason: string };

/** ESRCH is the only bounded proof that a recorded PID is absent. */
export function probePidPresence(pid: number): "absent" | "occupied" {
  try {
    process.kill(pid, 0);
    return "occupied";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "occupied";
  }
}

/**
 * Decide startup admission under the exact Membership mutation lease. Runtime
 * status is authoritative only for this bounded process-generation decision.
 */
export function admitRuntimeStartup(
  member: Pick<Member, "name" | "membershipId" | "sessionFile" | "pendingLaunchId">,
  sessionFile: string,
  status: AgentRuntimeStatus | null,
  pid: number = process.pid,
  probe: (pid: number) => "absent" | "occupied" = probePidPresence,
  launchId?: string,
): RuntimeStartupAdmission {
  if (!member.membershipId) return { kind: "refused", reason: `Current Membership for ${member.name} has no stable identity.` };
  if (!member.sessionFile) {
    if (!member.pendingLaunchId || launchId !== member.pendingLaunchId) {
      return { kind: "refused", reason: `Prepared Membership for ${member.name} has no matching launch capability.` };
    }
    const generation = runtimeGeneration(status);
    if (!generation) return status === null
      ? { kind: "admitted", action: "claim" }
      : { kind: "refused", reason: `Runtime evidence for prepared ${member.name} is malformed.` };
    if (generation.membershipId !== member.membershipId) {
      return { kind: "refused", reason: `Runtime evidence for prepared ${member.name} belongs to another Membership.` };
    }
    // A prepared Membership has no completed Session binding. A same-PID
    // record can only be a prior claim whose bind failed, not an idempotent
    // Session re-entry. Keep it fenced until exact exit evidence exists.
    if (probe(generation.pid) === "absent") return { kind: "admitted", action: "claim", replaces: generation };
    return { kind: "refused", reason: `Prepared Membership for ${member.name} already has a live or unverified Pi process generation (PID ${generation.pid}).` };
  }
  if (member.sessionFile !== sessionFile) {
    return { kind: "refused", reason: `Session ${sessionFile} is not the current binding for ${member.name}.` };
  }
  const generation = runtimeGeneration(status);
  if (!generation || generation.membershipId !== member.membershipId) {
    return { kind: "refused", reason: `Runtime evidence for already Session-bound ${member.name} is missing, malformed, or belongs to another Membership.` };
  }
  if (generation.pid === pid) return { kind: "admitted", action: "already_current" };
  if (probe(generation.pid) === "absent") return { kind: "admitted", action: "claim", replaces: generation };
  return { kind: "refused", reason: `Current Membership for ${member.name} already has a live or unverified Pi process generation (PID ${generation.pid}).` };
}

/**
 * Write runtime status for an agent. Merges with existing status.
 */
export async function writeRuntimeStatus(
  teamName: string,
  agentName: string,
  updates: Partial<AgentRuntimeStatus>,
  membershipId?: string,
): Promise<AgentRuntimeStatus> {
  const p = runtimeStatusPath(teamName, agentName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return await withLock(p, async () => {
    let current: AgentRuntimeStatus = {
      teamName,
      agentName,
    };

    if (fs.existsSync(p)) {
      try {
        current = JSON.parse(fs.readFileSync(p, "utf-8")) as AgentRuntimeStatus;
      } catch {
        // Corrupted file, start fresh
        current = { teamName, agentName };
      }
    }

    const next: AgentRuntimeStatus = {
      ...current,
      ...updates,
      teamName,
      agentName,
      ...(membershipId ? { membershipId } : {}),
    };

    // Readers deliberately do not join producer locks. Publish a complete,
    // restrictive replacement so they observe either generation, never JSON mid-write.
    const temporary = path.join(dir, `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(next, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, p);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
    }
    return next;
  });
}

/**
 * Read runtime status for an agent. Returns null if not found.
 */
export async function readRuntimeStatus(
  teamName: string,
  agentName: string
): Promise<AgentRuntimeStatus | null> {
  const p = runtimeStatusPath(teamName, agentName);
  if (!fs.existsSync(p)) return null;

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as AgentRuntimeStatus;
    } catch {
      // Corrupted file
      return null;
    }
  });
}

/**
 * Delete runtime status for an agent. Called during shutdown.
 */
export async function deleteRuntimeStatus(
  teamName: string,
  agentName: string,
  expected: RuntimeGeneration,
): Promise<boolean> {
  const p = runtimeStatusPath(teamName, agentName);
  if (!fs.existsSync(p)) return false;

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) return false;
    try {
      const current = runtimeGeneration(JSON.parse(fs.readFileSync(p, "utf8")) as AgentRuntimeStatus);
      if (
        !current
        || current.membershipId !== expected.membershipId
        || current.pid !== expected.pid
        || current.startedAt !== expected.startedAt
      ) return false;
      fs.unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Clean up stale runtime files for a team.
 * Removes files older than RUNTIME_STALE_MS that have no recent heartbeat.
 * Returns the number of files cleaned up.
 */
export async function cleanupStaleRuntimeFiles(
  teamName: string,
  now: number = Date.now()
): Promise<number> {
  const runtimeDir = path.join(teamDir(teamName), "runtime");
  if (!fs.existsSync(runtimeDir)) return 0;

  let cleaned = 0;
  const files = fs.readdirSync(runtimeDir).filter(f => f.endsWith(".json"));

  for (const file of files) {
    const p = path.join(runtimeDir, file);
    try {
      const status = JSON.parse(fs.readFileSync(p, "utf-8")) as AgentRuntimeStatus;
      
      // Check if the file is stale
      const lastActivity = status.lastHeartbeatAt || status.startedAt || 0;
      const isStale = (now - lastActivity) > RUNTIME_STALE_MS;
      
      if (isStale) {
        await withLock(p, async () => {
          if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            cleaned++;
          }
        });
      }
    } catch {
      // Corrupted file, remove it
      try {
        fs.unlinkSync(p);
        cleaned++;
      } catch {
        // Ignore removal errors
      }
    }
  }

  return cleaned;
}

/**
 * Create a structured error object from an error.
 */
export function createRuntimeError(error: unknown): RuntimeError {
  return {
    message: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}
