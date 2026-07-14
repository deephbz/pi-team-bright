import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { runtimeStatusPath, teamDir } from "./paths";

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

    fs.writeFileSync(p, JSON.stringify(next, null, 2));
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
