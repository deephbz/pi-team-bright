import fs from "node:fs";
import path from "node:path";
import { teamDir } from "./paths";
import type {
  CoordinationMemberEvidence,
  CoordinationQueryBundle,
  CoordinationRuntimeEvidence,
  CoordinationRuntimeGeneration,
} from "../coordination/queries";

export type WorkerRunState = "active" | "settled" | "unknown" | "absent";

export interface WorkerRunObservation {
  worker: string;
  membershipId?: string;
  generation?: CoordinationRuntimeGeneration;
  state: WorkerRunState;
  /** True when a carrier or delivery can produce a future run. */
  actuationPending: boolean;
}

function exactStatus(member: CoordinationMemberEvidence, status: CoordinationRuntimeEvidence | null): CoordinationRuntimeGeneration | undefined {
  if (
    !member.membershipId
    || !status?.membershipId
    || !Number.isSafeInteger(status.pid)
    || status.pid! <= 1
    || !Number.isFinite(status.startedAt)
    || status.startedAt! <= 0
    || status.membershipId !== member.membershipId
  ) return undefined;
  return { membershipId: status.membershipId, pid: status.pid!, startedAt: status.startedAt! };
}

/** Pure liveness projection over already-read Team, runtime, and actuation evidence. */
export function deriveWorkerRunObservation(
  member: CoordinationMemberEvidence,
  evidence: {
    runtime: CoordinationRuntimeEvidence | null;
    taskDelivery: { known: boolean; pending: boolean };
    alertInbox: { known: boolean; pending: boolean };
  },
): WorkerRunObservation {
  const actuationPending = (!member.sessionFile && !!member.pendingLaunchId) || evidence.taskDelivery.pending || evidence.alertInbox.pending;
  const actuationKnown = evidence.taskDelivery.known && evidence.alertInbox.known;
  if (member.isActive === false) return { worker: member.name, state: "absent", actuationPending: false };
  const generation = exactStatus(member, evidence.runtime);
  if (!member.sessionFile) return { worker: member.name, membershipId: member.membershipId, generation, state: !actuationKnown || actuationPending ? "unknown" : "absent", actuationPending };
  if (!generation || !actuationKnown) return { worker: member.name, membershipId: member.membershipId, generation, state: "unknown", actuationPending };
  if (evidence.runtime?.runState === "active") return { worker: member.name, membershipId: member.membershipId, generation, state: "active", actuationPending };
  if (evidence.runtime?.runState === "settled") return { worker: member.name, membershipId: member.membershipId, generation, state: "settled", actuationPending };
  return { worker: member.name, membershipId: member.membershipId, generation, state: "unknown", actuationPending };
}

/** Reads liveness from the caller's explicit Coordination query bundle. */
export async function readWorkerRunObservation(
  teamName: string,
  member: CoordinationMemberEvidence,
  queries: CoordinationQueryBundle,
): Promise<WorkerRunObservation> {
  const [taskDelivery, alertInbox, runtime] = await Promise.all([
    queries.taskStateDelivery.readDeliveryEvidence(teamName, member.name),
    queries.alertActuation.readInboxEvidence(teamName, member.name),
    queries.teamRuntime.readRuntime(teamName, member).catch(() => null),
  ]);
  return deriveWorkerRunObservation(member, { runtime, taskDelivery, alertInbox });
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
    let scanning = false;
    let pending: "hint" | "authority" | undefined;
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
    const requestScan = (kind: "hint" | "authority") => {
      if (settled) return;
      if (scanning) {
        // Keep only one deferred scan. Authority covers hint state too, so it
        // replaces a pending hint instead of letting filesystem noise grow work.
        if (kind === "authority" || pending === undefined) pending = kind;
        return;
      }
      scanning = true;
      void (async () => {
        try {
          const check = kind === "authority" ? (options.checkAuthority ?? options.check) : options.check;
          if (await check()) finish("hint");
        } catch (error) {
          finish(undefined, error);
        } finally {
          scanning = false;
          const next = pending;
          pending = undefined;
          if (!settled && next) requestScan(next);
        }
      })();
    };
    const onAbort = () => {
      const error = new Error("Team liveness wait aborted");
      error.name = "AbortError";
      finish(undefined, error);
    };
    const eventJournal = "team-events.jsonl";
    const runtimeWatcher = fs.watch(runtimeDirectory, (_event, filename) => {
      // Atomic runtime replacement reports the final status filename. Null,
      // empty, and non-string names are not actionable: macOS can emit them
      // for unrelated directory activity and create a rescan feedback loop.
      // The periodic authority scan remains the bounded fallback.
      if (typeof filename === "string" && filename.endsWith(".json")) requestScan("hint");
    });
    runtimeWatcher.on("error", (error) => finish(undefined, error));
    watchers.push(runtimeWatcher);
    const eventWatcher = fs.watch(eventDirectory, (_event, filename) => {
      if (typeof filename === "string" && filename === eventJournal) requestScan("hint");
    });
    eventWatcher.on("error", (error) => finish(undefined, error));
    watchers.push(eventWatcher);
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
    interval = setInterval(() => requestScan("authority"), Math.min(authorityCheckMs, Math.max(25, options.waitMs)));
    interval.unref?.();
    // This closes the registration race. The observation service performs the
    // final complete authority read after this waiter settles.
    requestScan("authority");
  });
}

export function currentMember(members: readonly (CoordinationMemberEvidence & { agentType?: string })[], worker: string): CoordinationMemberEvidence | undefined {
  return [...members].reverse().find((member) => member.name === worker && member.agentType === "teammate" && member.isActive !== false);
}

export function livenessIsProductive(observations: readonly WorkerRunObservation[]): boolean {
  return observations.some((observation) => observation.state === "active" || observation.actuationPending);
}

export function livenessIsComplete(observations: readonly WorkerRunObservation[]): boolean {
  return observations.every((observation) => !observation.actuationPending && (observation.state === "settled" || observation.state === "absent"));
}
