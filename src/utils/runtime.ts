import { hostEnv, type GenerationProbe } from "../env/host-env";
import { MISSING_GENERATION_HELPER_MESSAGE } from "../env/process-generation";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { withLock } from "./lock";
import { runtimeStatusPath, teamDir } from "./paths";
import type { Member } from "../team-authority/contracts";
import type { DeliveryDegradation, DeliveryEngineName, DeliveryEngineState } from "./recipient-delivery-lifecycle";

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
  osBirthToken?: string;
  bootId?: string;
  startedAt?: number;
  lastHeartbeatAt?: number;
  lastInboxReadAt?: number;
  ready?: boolean;
  /** Exact Pi 0.83 agent lifecycle evidence for the current generation. */
  runState?: "active" | "settled";
  delivery?: { sessionFile: string; engines: Partial<Record<DeliveryEngineName, DeliveryEngineState>> };
  lastError?: RuntimeError;
  lastStop?: { stopId?: string; piReason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string; observedAt: number; suspectedHumanStop: boolean };
  stopRequested?: "worker_stop" | "team_shutdown" | "compensation";
}

/** Delivery observations apply only to this bound, verified process generation. */
export function currentDeliveryDegradations(
  member: Pick<Member, "membershipId" | "sessionFile">,
  status: AgentRuntimeStatus | null,
  verified: "live" | "gone" | "unknown",
): DeliveryDegradation[] {
  if (!member.membershipId || status?.membershipId !== member.membershipId || !member.sessionFile
    || status.delivery?.sessionFile !== member.sessionFile || verified !== "live" || status.lastStop) return [];
  return Object.values(status.delivery.engines).flatMap(state => {
    if (state?.state !== "degraded") return [];
    const { state: _state, ...degradation } = state;
    return [degradation];
  });
}

/** Exact ephemeral process generation within one durable Membership. */
export interface RuntimeGeneration {
  membershipId: string;
  pid: number;
  startedAt: number;
  osBirthToken?: string;
  bootId?: string;
}

/** Tokenless legacy records fail closed until their own process re-admits. */
export function verifyRuntimeGeneration(status: Pick<AgentRuntimeStatus, "pid" | "osBirthToken" | "bootId"> | null, probe: GenerationProbe): "live" | "gone" | "unknown" {
  if (!status?.pid || !status.osBirthToken || !status.bootId) return "unknown";
  if (probe.kind === "absent") return "gone";
  if (probe.kind === "unknown") return "unknown";
  return probe.generation.osBirthToken === status.osBirthToken && probe.generation.bootId === status.bootId ? "live" : "gone";
}

export function ownBirthIdentity(probe: GenerationProbe): { osBirthToken?: string; bootId?: string } {
  return probe.kind === "found" ? { osBirthToken: probe.generation.osBirthToken, bootId: probe.generation.bootId } : {};
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
    ...(status.osBirthToken ? { osBirthToken: status.osBirthToken, bootId: status.bootId } : {}),
  };
}

/** One current Membership admits one live Pi process generation. */
export type RuntimeStartupAdmission =
  | { kind: "admitted"; action: "claim" | "already_current"; replaces?: RuntimeGeneration }
  | { kind: "refused"; reason: string; nextActionHint?: "ask_human" };

/**
 * Decide startup admission under the exact Membership mutation lease. Runtime
 * status is authoritative only for this bounded process-generation decision.
 */
export function admitRuntimeStartup(
  member: Pick<Member, "name" | "membershipId" | "sessionFile" | "pendingLaunchId">,
  sessionFile: string,
  status: AgentRuntimeStatus | null,
  pid: number,
  observed: GenerationProbe,
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
    if (observed.kind === "unknown" && observed.reason === "generation_helper_missing") {
      return { kind: "refused", reason: MISSING_GENERATION_HELPER_MESSAGE, nextActionHint: "ask_human" };
    }
    // A prepared Membership has no completed Session binding. A same-PID
    // record can only be a prior claim whose bind failed, not an idempotent
    // Session re-entry. Keep it fenced until exact exit evidence exists.
    if (verifyRuntimeGeneration(status, observed) === "gone") return { kind: "admitted", action: "claim", replaces: generation };
    return { kind: "refused", reason: `Prepared Membership for ${member.name} already has a live or unverified Pi process generation (PID ${generation.pid}).` };
  }
  if (member.sessionFile !== sessionFile) {
    return { kind: "refused", reason: `Session ${sessionFile} is not the current binding for ${member.name}.` };
  }
  const generation = runtimeGeneration(status);
  if (!generation || generation.membershipId !== member.membershipId) {
    return { kind: "refused", reason: `Runtime evidence for already Session-bound ${member.name} is missing, malformed, or belongs to another Membership.` };
  }
  const helperMissing = observed.kind === "unknown" && observed.reason === "generation_helper_missing";
  // Exact bound re-entry does not replace a generation. A missing helper must
  // not eject the current process from its own Session during reload.
  if (generation.pid === pid && (helperMissing || !status?.osBirthToken || verifyRuntimeGeneration(status, observed) === "live")) return { kind: "admitted", action: "already_current" };
  if (helperMissing) {
    return { kind: "refused", reason: MISSING_GENERATION_HELPER_MESSAGE, nextActionHint: "ask_human" };
  }
  if (verifyRuntimeGeneration(status, observed) === "gone") return { kind: "admitted", action: "claim", replaces: generation };
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
  await fsp.mkdir(dir, { recursive: true });

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

    const nextMembershipId = membershipId ?? updates.membershipId ?? current.membershipId;
    const replacementGeneration =
      (nextMembershipId !== current.membershipId)
      || (updates.pid !== undefined && updates.pid !== current.pid)
      || (updates.startedAt !== undefined && updates.startedAt !== current.startedAt);
    const next: AgentRuntimeStatus = {
      ...(replacementGeneration ? { teamName, agentName } : current),
      ...updates,
      teamName,
      agentName,
      ...(membershipId ? { membershipId } : {}),
    };

    // Readers deliberately do not join producer locks. Publish a complete,
    // restrictive replacement so they observe either generation, never JSON mid-write.
    const temporary = path.join(dir, `.${path.basename(p)}.${hostEnv().process.pid}.${hostEnv().clock.now()}.tmp`);
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(next, null, 2));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsp.rename(temporary, p);
    } finally {
      if (handle) try { await handle.close(); } catch {}
      try { await fsp.unlink(temporary); } catch {}
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
  // Writers retain the lock and atomically replace this file. Readers must not
  // join that lock: a liveness snapshot may use the prior complete generation.
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as AgentRuntimeStatus;
  } catch (error) {
    // A concurrent replacement can make the path absent between operations.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Corrupted or unavailable evidence fails closed at the caller.
    return null;
  }
}

/**
 * Restore an exact deleted runtime generation only when the runtime file is
 * still absent (or already contains that exact generation). A replacement is
 * never overwritten during shutdown compensation.
 */
export async function restoreRuntimeStatus(
  teamName: string,
  agentName: string,
  status: AgentRuntimeStatus,
  expected: RuntimeGeneration,
): Promise<boolean> {
  const generation = runtimeGeneration(status);
  if (
    status.teamName !== teamName
    || status.agentName !== agentName
    || !generation
    || generation.membershipId !== expected.membershipId
    || generation.pid !== expected.pid
    || generation.startedAt !== expected.startedAt
  ) return false;
  const p = runtimeStatusPath(teamName, agentName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return withLock(p, async () => {
    if (fs.existsSync(p)) {
      try {
        const current = runtimeGeneration(JSON.parse(fs.readFileSync(p, "utf8")) as AgentRuntimeStatus);
        return !!current
          && current.membershipId === expected.membershipId
          && current.pid === expected.pid
          && current.startedAt === expected.startedAt;
      } catch {
        return false;
      }
    }
    const temporary = path.join(dir, `.${path.basename(p)}.${hostEnv().process.pid}.${hostEnv().clock.now()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(status, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, p);
      return true;
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  });
}

/** Delete only the exact runtime generation expected by shutdown/recovery. */
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
  now: number = hostEnv().clock.now()
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
    timestamp: hostEnv().clock.now(),
  };
}
