import { herdrCarrierName } from "../adapters/herdr-adapter";
import { hostEnv, type TimerHandle } from "../env/host-env";
import type { Member } from "../team-authority/contracts";
import { readRuntimeStatus, runtimeGeneration, verifyRuntimeGeneration, type AgentRuntimeStatus, type RuntimeGeneration } from "../utils/runtime";
import { readConfig } from "../utils/teams";
import { appendTeamEvent, readTeamEvents } from "./event-journal";

export type LaunchState = "none" | "requested" | "started" | "refused" | "unknown";
export type ProcessState = "live" | "stopping" | "gone" | "unknown";
export type NextActionHint = "ensure_worker" | "ask_human" | "wait";
export interface CarrierView {
  worker: string;
  membership: string;
  launchId?: string;
  generation?: RuntimeGeneration;
  binding: "unbound" | "bound";
  sessionFile?: string;
  launch: LaunchState;
  process: ProcessState;
  terminal: "present" | "absent" | "unknown";
  activity: "working" | "idle" | "blocked" | "unknown";
  lastStop?: AgentRuntimeStatus["lastStop"];
  paneId?: string;
  evidence: Array<{ source: string; fact: string; observedAt: number }>;
}
export interface CarrierEvent {
  membership: string;
  launchId?: string;
  generation?: RuntimeGeneration;
  field: "binding" | "launch" | "process" | "terminal" | "blocked";
  from: string;
  to: string;
  cause: { source: string; fact: string };
  observedAt: number;
  paneId?: string;
  suspectedHumanStop: boolean;
  nextActionHint: NextActionHint;
}
export function deriveCarrierView(member: Member, status: AgentRuntimeStatus | null, now = hostEnv().clock.now()): CarrierView {
  const exact = status?.membershipId === member.membershipId ? status : null;
  const verified = verifyRuntimeGeneration(exact);
  const process = verified === "live" && exact?.lastStop ? "stopping" : verified;
  return { worker: member.name, membership: member.membershipId ?? "", launchId: member.launch?.launchId ?? member.pendingLaunchId,
    generation: runtimeGeneration(exact) ?? undefined, binding: member.sessionFile ? "bound" : "unbound", sessionFile: member.sessionFile,
    launch: member.launch?.state ?? (member.pendingLaunchId ? "unknown" : "none"), process,
    terminal: "unknown", activity: "unknown", lastStop: exact?.lastStop,
    paneId: member.terminalTarget?.targetId ?? member.tmuxPaneId,
    evidence: [{ source: "process_generation", fact: verified, observedAt: now },
      ...(exact?.lastStop ? [{ source: "session_shutdown", fact: exact.lastStop.piReason, observedAt: exact.lastStop.observedAt }] : [])] };
}

/** One in-flight bounded read per source. Invalid or partial responses never prove absence. */
export async function herdrList(source: "agent" | "pane"): Promise<Record<string, unknown>[] | undefined> {
  const result = await hostEnv().exec.run("herdr", [source, "list"], { timeoutMs: 2000 });
  if (result.kind !== "exited" || result.status !== 0) return undefined;
  try {
    const envelope = JSON.parse(result.stdout);
    if (envelope.error) return undefined;
    const data = envelope.result ?? envelope;
    const rows = data[source === "agent" ? "agents" : "panes"];
    if (!Array.isArray(rows) || data.partial === true || !rows.every(row => row && typeof row === "object" && typeof row.pane_id === "string")) return undefined;
    return rows;
  } catch { return undefined; }
}

/** Ephemeral projection. It owns observations, never Membership or Task transitions. */
export class CarrierObserver {
  readonly views = new Map<string, CarrierView>();
  private timer?: TimerHandle;
  private stopped = false;
  private inFlight?: Promise<void>;
  private outage = false;
  private blocked = new Map<string, { since: number; emitted: boolean; attempt: string }>();
  constructor(private readonly teamName: string, private readonly notify: (text: string) => void = () => {}) {}
  start(): void { this.stopped = false; void this.tick(); }
  stop(): void { this.stopped = true; hostEnv().clock.clearTimeout(this.timer); }
  private async tick(): Promise<void> {
    try { await this.refresh(); } catch { /* A failed source retains uncertainty; the next poll retries. */ }
    if (!this.stopped) this.timer = hostEnv().clock.setTimeout(() => void this.tick(), 2000 + hostEnv().random.float() * 3000);
  }
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async collect(): Promise<void> {
    const config = await readConfig(this.teamName);
    const now = hostEnv().clock.now();
    const [agents, panes] = config.terminalBackend === "herdr" ? await Promise.all([herdrList("agent"), herdrList("pane")]) : [undefined, undefined];
    if (this.stopped) return;
    const unavailable = config.terminalBackend === "herdr" && (!agents || !panes);
    if (unavailable && !this.outage) {
      await appendTeamEvent(this.teamName, { type: "alert", alertId: hostEnv().random.uuid(), from: "team-lead", to: "team-lead", kind: "attention", text: "Herdr observation unavailable. Process verification continues. Wait for reconnect before placement or recovery." });
    }
    this.outage = unavailable;
    const events = readTeamEvents(this.teamName, { afterCursor: "0" }).events;
    for (const member of config.members.filter(m => m.agentType === "teammate" && m.isActive !== false)) {
      const status = await readRuntimeStatus(this.teamName, member.name);
      const view = deriveCarrierView(member, status, now);
      const prior = this.views.get(view.membership);
      if (panes && view.paneId) view.terminal = panes.some(row => row.pane_id === view.paneId) ? "present" : "absent";
      const agent = agents?.find(row => row.name === herdrCarrierName(this.teamName, member.name) && row.pane_id === view.paneId && row.agent_session === member.sessionFile);
      if (agent && ["working", "idle", "blocked"].includes(String(agent.agent_status))) view.activity = agent.agent_status as CarrierView["activity"];
      view.evidence.push({ source: "herdr_panes", fact: view.terminal, observedAt: now }, { source: "herdr_agents", fact: view.activity, observedAt: now });
      const reloading = view.lastStop?.piReason === "reload" || (prior?.lastStop?.piReason === "reload" && view.process === "live");
      for (const field of ["binding", "launch", "process", "terminal"] as const) {
        if (view[field] === prior?.[field] || (field === "terminal" && view.terminal !== "absent")) continue;
        if (reloading && field === "process") continue;
        if (!prior && ["none", "unknown", "bound", "live"].includes(view[field])) continue;
        await this.publish(view, field, prior?.[field] ?? "unknown", view[field], status);
      }
      if (view.lastStop?.piReason === "reload" && now - view.lastStop.observedAt >= 15000 && prior?.process === "stopping" && prior.lastStop?.observedAt === view.lastStop.observedAt) {
        // The transition is suppressed during a normal reload. Emit only once after the hang bound.
        if (!prior.evidence.some(e => e.fact === "reload_hung")) await this.publish(view, "process", "live", "stopping", status);
        view.evidence.push({ source: "session_shutdown", fact: "reload_hung", observedAt: now });
      }
      const attempt = events.filter(event => event.type === "task" && event.actor === member.name).at(-1)?.cursor ?? "0";
      const block = this.blocked.get(view.membership);
      if (!block || block.attempt !== attempt) this.blocked.set(view.membership, { since: now, emitted: false, attempt });
      const currentBlock = this.blocked.get(view.membership)!;
      if (view.activity !== "blocked") currentBlock.since = now;
      else if (!currentBlock.emitted && now - currentBlock.since >= 3000) {
        await this.publish(view, "blocked", "unknown", "blocked", status);
        currentBlock.emitted = true;
      }
      this.views.set(view.membership, view);
    }
  }
  private async publish(view: CarrierView, field: CarrierEvent["field"], from: string, to: string, status: AgentRuntimeStatus | null): Promise<void> {
    const suspectedHumanStop = !!view.lastStop?.suspectedHumanStop || (view.terminal === "absent" && !status?.stopRequested);
    const cause = field === "process" && view.lastStop && to === "stopping"
      ? { source: "session_shutdown", fact: view.lastStop.piReason }
      : { source: field === "terminal" ? "herdr_panes" : field === "blocked" ? "herdr_agents" : field === "process" ? "process_generation" : "membership", fact: to };
    const carrier: CarrierEvent = { membership: view.membership, launchId: view.launchId, generation: view.generation, field, from, to, cause,
      observedAt: hostEnv().clock.now(), paneId: view.paneId, suspectedHumanStop,
      nextActionHint: suspectedHumanStop || field === "blocked" || to === "stopping" ? "ask_human" : to === "gone" || to === "refused" ? "ensure_worker" : "wait" };
    await appendTeamEvent(this.teamName, { type: "worker", worker: view.worker, membershipId: view.membership, phase: "stopped", carrier });
    this.notify(`Worker ${view.worker}: ${field} ${to} (${cause.source}: ${cause.fact}); pane ${view.paneId ?? "unknown"}; ${carrier.nextActionHint}.`);
  }
}
