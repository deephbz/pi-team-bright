import fs from "node:fs";
import path from "node:path";
import { inboxPath, taskDeliveryPath, teamDir } from "./paths";
import { readRuntimeStatus, runtimeGeneration, type AgentRuntimeStatus, type RuntimeGeneration } from "./runtime";
import type { Member } from "../team-authority/contracts";

export type WorkerRunState = "active" | "settled" | "unknown" | "absent";

export interface WorkerRunObservation {
  worker: string;
  membershipId?: string;
  generation?: RuntimeGeneration;
  state: WorkerRunState;
  /** True when a carrier or delivery can produce a future run. */
  actuationPending: boolean;
}

type ActuationEvidence = { known: boolean; pending: boolean };

function exactStatus(member: Member, status: AgentRuntimeStatus | null): RuntimeGeneration | undefined {
  const generation = runtimeGeneration(status);
  if (!member.membershipId || !generation || generation.membershipId !== member.membershipId) return undefined;
  return generation;
}

/** Read runtime evidence without treating heartbeat or terminal state as liveness. */
export async function readWorkerRunObservation(teamName: string, member: Member): Promise<WorkerRunObservation> {
  const delivery = hasPendingTaskDelivery(teamName, member.name);
  const inbox = hasPendingInboxMessage(teamName, member.name);
  const actuationPending = (!member.sessionFile && !!member.pendingLaunchId) || delivery.pending || inbox.pending;
  const actuationKnown = delivery.known && inbox.known;
  if (member.isActive === false) return { worker: member.name, state: "absent", actuationPending: false };
  const status = await readRuntimeStatusForMember(teamName, member);
  const generation = exactStatus(member, status);
  if (!member.sessionFile) return { worker: member.name, membershipId: member.membershipId, generation, state: !actuationKnown || actuationPending ? "unknown" : "absent", actuationPending };
  if (!generation || !actuationKnown) return { worker: member.name, membershipId: member.membershipId, generation, state: "unknown", actuationPending };
  if (status?.runState === "active") return { worker: member.name, membershipId: member.membershipId, generation, state: "active", actuationPending };
  if (status?.runState === "settled") return { worker: member.name, membershipId: member.membershipId, generation, state: "settled", actuationPending };
  return { worker: member.name, membershipId: member.membershipId, generation, state: "unknown", actuationPending };
}

function hasPendingTaskDelivery(teamName: string, worker: string): ActuationEvidence {
  const file = taskDeliveryPath(teamName, worker);
  if (!fs.existsSync(file)) return { known: true, pending: false };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(value) || value.some((record) => !record || typeof record !== "object" || typeof (record as { successfulTurnAckAt?: unknown }).successfulTurnAckAt !== "string" && (record as { successfulTurnAckAt?: unknown }).successfulTurnAckAt !== undefined)) return { known: false, pending: false };
    return { known: true, pending: value.some((record) => !(record as { successfulTurnAckAt?: string }).successfulTurnAckAt) };
  } catch {
    return { known: false, pending: false };
  }
}

function hasPendingInboxMessage(teamName: string, worker: string): ActuationEvidence {
  const file = inboxPath(teamName, worker);
  if (!fs.existsSync(file)) return { known: true, pending: false };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(value) || value.some((message) => !message || typeof message !== "object" || typeof (message as { read?: unknown }).read !== "boolean")) return { known: false, pending: false };
    return { known: true, pending: value.some((message) => !(message as { read: boolean }).read) };
  } catch {
    return { known: false, pending: false };
  }
}

async function readRuntimeStatusForMember(teamName: string, member: Member): Promise<AgentRuntimeStatus | null> {
  try {
    return await readRuntimeStatus(teamName, member.name);
  } catch {
    return null;
  }
}

export interface LivenessWaitOptions {
  teamName: string;
  waitMs: number;
  signal?: AbortSignal;
  /** Low-cost authority revision cadence; event and runtime hints stay immediate. */
  authorityCheckMs?: number;
  /** Positive producer hint. Event and runtime scans must stay low cost. */
  check: () => boolean | Promise<boolean>;
  /** Optional bounded authority scan for revisions without producer events. */
  checkAuthority?: () => boolean | Promise<boolean>;
}

/** Wait for a journal/runtime producer hint, then let the caller recheck. */
export async function waitForLivenessHint(options: LivenessWaitOptions): Promise<"hint" | "timeout"> {
  if (!Number.isFinite(options.waitMs) || options.waitMs < 0) throw new Error("Liveness wait must be a nonnegative finite number.");
  if (options.signal?.aborted) {
    const error = new Error("Team liveness wait aborted");
    error.name = "AbortError";
    throw error;
  }
  const runtimeDirectory = path.join(teamDir(options.teamName), "runtime");
  const eventDirectory = path.join(teamDir(options.teamName), "events");
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.mkdirSync(eventDirectory, { recursive: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    const watchers: fs.FSWatcher[] = [];
    const finish = (result?: "hint" | "timeout", error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      for (const watcher of watchers) watcher.close();
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(result!);
    };
    const scan = async (authority = false) => {
      if (settled) return;
      try {
        const check = authority ? (options.checkAuthority ?? options.check) : options.check;
        if (await check()) finish("hint");
      } catch (error) {
        finish(undefined, error);
      }
    };
    const onAbort = () => {
      const error = new Error("Team liveness wait aborted");
      error.name = "AbortError";
      finish(undefined, error);
    };
    for (const directory of [runtimeDirectory, eventDirectory]) {
      const watcher = fs.watch(directory, () => { void scan(); });
      watcher.on("error", (error) => finish(undefined, error));
      watchers.push(watcher);
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish("timeout"), options.waitMs);
    timer.unref?.();
    // A Task authority may commit without an event append. While a positive
    // Worker producer exists, this bounded recheck covers that hint class.
    const authorityCheckMs = options.authorityCheckMs ?? 5_000;
    if (!Number.isFinite(authorityCheckMs) || authorityCheckMs <= 0) {
      finish(undefined, new Error("authorityCheckMs must be a positive finite number."));
      return;
    }
    interval = setInterval(() => { void scan(true); }, Math.min(authorityCheckMs, Math.max(25, options.waitMs)));
    interval.unref?.();
    void scan(true);
  });
}

export function currentMember(members: readonly Member[], worker: string): Member | undefined {
  return [...members].reverse().find((member) => member.name === worker && member.agentType === "teammate" && member.isActive !== false);
}

export function livenessIsProductive(observations: readonly WorkerRunObservation[]): boolean {
  return observations.some((observation) => observation.state === "active" || observation.actuationPending);
}

export function livenessIsComplete(observations: readonly WorkerRunObservation[]): boolean {
  return observations.every((observation) => !observation.actuationPending && (observation.state === "settled" || observation.state === "absent"));
}
