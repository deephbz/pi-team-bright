import fs from "node:fs";
import { herdrPiSessionPath } from "./adapters/herdr-session";
import { herdrCarrierName } from "./adapters/herdr-adapter";
import { hostEnv, type TimerHandle, type GenerationProbe } from "./env/host-env";
import type { Member, TeamConfig } from "./team-authority/contracts";
import { readRuntimeStatus, runtimeGeneration, verifyRuntimeGeneration, type AgentRuntimeStatus, type RuntimeGeneration } from "./utils/runtime";
import { configPath } from "./utils/paths";
import { withCurrentMembershipLease } from "./utils/teams";
import type { WorkerTeamEvent } from "./coordination/contracts";
import { appendTeamEvent, readTeamEvents } from "./coordination/event-journal";

export type LaunchState = "none" | "requested" | "started" | "refused" | "unknown";
export type ProcessState = "live" | "stopping" | "gone" | "unknown" | "none";
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
  evidence: Array<{ source: string; fact: string; observedAt: number; lastGoodAt?: number; expiresAt?: number }>;
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
export function deriveCarrierView(member: Member, status: AgentRuntimeStatus | null, now = hostEnv().clock.now(), observed?: GenerationProbe): CarrierView {
  const exact = status?.membershipId === member.membershipId ? status : null;
  const probe = observed ?? (exact?.pid ? hostEnv().process.generation(exact.pid) : { kind: "unknown" as const, reason: "runtime_missing" });
  const verified = verifyRuntimeGeneration(exact, probe);
  const processFact = !exact?.osBirthToken && exact?.pid ? "birth_token_missing" : probe.kind === "unknown" ? probe.reason : verified;
  const process = status === null && member.launch?.state === "refused" && !member.launch.priorGeneration ? "none"
    : verified === "live" && exact?.lastStop ? "stopping" : verified;
  return { worker: member.name, membership: member.membershipId ?? "", launchId: member.launch?.launchId ?? member.pendingLaunchId,
    generation: runtimeGeneration(exact) ?? undefined, binding: member.sessionFile ? "bound" : "unbound", sessionFile: member.sessionFile,
    launch: member.launch?.state ?? (member.pendingLaunchId ? "unknown" : "none"), process,
    terminal: "unknown", activity: "unknown", lastStop: exact?.lastStop,
    paneId: member.terminalTarget?.targetId ?? member.tmuxPaneId,
    evidence: [{ source: "process_generation", fact: processFact, observedAt: now },
      { source: "launch", fact: member.launch?.fact ?? (member.launch?.state ?? "none"), observedAt: member.launch?.observedAt ?? member.launch?.requestedAt ?? now },
      ...(exact?.lastStop ? [{ source: "session_shutdown", fact: exact.lastStop.piReason, observedAt: exact.lastStop.observedAt }] : [])] };
}

/** One in-flight bounded read per source. Invalid or partial responses never prove absence. */
export async function herdrList(source: "agent" | "pane"): Promise<Record<string, unknown>[] | undefined> {
  const result = await hostEnv().exec.run("herdr", [source, "list"], { timeoutMs: 2000 });
  if (result.kind !== "exited") throw new Error(`herdr_${source}_${result.kind}`);
  if (result.status !== 0) throw new Error(`herdr_${source}_exit:${result.status}`);
  try {
    const envelope = JSON.parse(result.stdout);
    if (envelope.error) throw new Error(`herdr_${source}_error:${envelope.error.code ?? "unavailable"}`);
    const data = envelope.result ?? envelope;
    const rows = data[source === "agent" ? "agents" : "panes"];
    if (!Array.isArray(rows) || data.partial === true || !rows.every(row => row && typeof row === "object" && typeof row.pane_id === "string")) throw new Error(`herdr_${source}_partial_or_malformed`);
    return rows;
  } catch (error) { throw error instanceof SyntaxError ? new Error(`herdr_${source}_malformed_json`) : error; }
}

/** Ephemeral projection. It owns observations, never Membership or Task transitions. */
export const CARRIER_SAMPLE_TTL_MS = 6000;
type SourceSample<T> = { value?: T; observedAt: number; fact?: string };

export class CarrierObserver {
  private readonly projection = new Map<string, CarrierView>();
  get views(): ReadonlyMap<string, CarrierView> { this.expire(); return this.projection; }
  private readonly sourceReads = new Map<string, Promise<SourceSample<any>>>();
  private expire(): void {
    const now = hostEnv().clock.now();
    for (const view of this.projection.values()) {
      for (const [source, field] of [["process_generation", "process"], ["herdr_agents", "activity"], ["herdr_panes", "terminal"]] as const) {
        const evidence = view.evidence.find(item => item.source === source);
        if (evidence && now >= (evidence.expiresAt ?? evidence.observedAt + CARRIER_SAMPLE_TTL_MS)) {
          view[field] = "unknown";
          if (!evidence.fact.startsWith("expired:")) evidence.fact = `expired:${evidence.fact}`;
        }
      }
    }
  }
  private async sample<T>(source: string, read: () => Promise<T>): Promise<SourceSample<T>> {
    let pending = this.sourceReads.get(source);
    if (!pending) {
      const observedAt = hostEnv().clock.now();
      pending = Promise.resolve().then(read).then(value => ({ value, observedAt }), error => ({ observedAt, fact: error instanceof Error ? error.message : "source_unavailable" }));
      this.sourceReads.set(source, pending);
      void pending.finally(() => { if (this.sourceReads.get(source) === pending) this.sourceReads.delete(source); });
    }
    let timer: TimerHandle | undefined;
    try {
      return await Promise.race([pending, new Promise<SourceSample<T>>(resolve => { timer = hostEnv().clock.setTimeout(() => resolve({ observedAt: hostEnv().clock.now(), fact: `${source}_timeout` }), 2000); })]);
    } finally { hostEnv().clock.clearTimeout(timer); }
  }
  private timer?: TimerHandle;
  private stopped = false;
  private inFlight?: Promise<void>;
  private outage = false;
  private lastGood = new Map<string, number>();
  private journalCursor = "0";
  private taskCursors = new Map<string, string>();
  private lastEvents = new Map<string, WorkerTeamEvent>();
  private journal = false;
  private blocked = new Map<string, { since: number; emitted: boolean; attempt: string }>();
  constructor(private readonly teamName: string, private readonly notify: (text: string) => void = () => {}) {}
  start(): void { this.stopped = false; this.journal = true; void this.tick(); }
  stop(): void { this.stopped = true; hostEnv().clock.clearTimeout(this.timer); }
  private async tick(): Promise<void> {
    try { await this.refresh(); } catch { /* A failed source retains uncertainty; the next poll retries. */ }
    if (!this.stopped) this.timer = hostEnv().clock.setTimeout(() => void this.tick(), 2000 + hostEnv().random.float() * 3000);
  }
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect().finally(() => { this.expire(); this.inFlight = undefined; });
    return this.inFlight;
  }
  private async collect(): Promise<void> {
    // The atomic Team file is a read-only snapshot. Observation never waits on a producer lease.
    const config = JSON.parse(fs.readFileSync(configPath(this.teamName), "utf8")) as TeamConfig;
    if (!Array.isArray(config.members) || !config.members.every(m => m && typeof m.name === "string")) return;
    const members = config.members.filter(m => m.agentType === "teammate" && m.isActive !== false);
    const statuses = new Map(await Promise.all(members.map(async member => [member.name, await readRuntimeStatus(this.teamName, member.name)] as const)));
    const pids = [...statuses.values()].flatMap(status => status?.pid ? [status.pid] : []);
    const priorViews = new Map([...this.views].map(([key, value]) => [key, structuredClone(value)]));
    const generationRead = this.sample("process_generation", () => hostEnv().process.generations?.(pids) ?? Promise.resolve(new Map(pids.map(pid => [pid, hostEnv().process.generation(pid)]))));
    const herdrReads = config.terminalBackend === "herdr" ? Promise.all([this.sample("herdr_agents", () => herdrList("agent")), this.sample("herdr_panes", () => herdrList("pane"))]) : Promise.resolve([undefined, undefined] as const);
    const generationSample = await generationRead;
    const generations = generationSample.value ?? new Map<number, GenerationProbe>();
    if (this.stopped) return;
    // Publish the process projection independently from the slower terminal sources.
    for (const member of members) {
      const status = statuses.get(member.name) ?? null;
      const probe = status?.pid ? generations.get(status.pid) ?? { kind: "unknown" as const, reason: generationSample.fact ?? "missing_batch_result" } : undefined;
      const view = deriveCarrierView(member, status, generationSample.observedAt, probe);
      const prior = priorViews.get(view.membership);
      if (prior) {
        view.terminal = prior.terminal; view.activity = prior.activity;
        view.evidence.push(...prior.evidence.filter(item => item.source.startsWith("herdr_")));
      }
      this.projection.set(view.membership, view);
    }
    const [agentSample, paneSample] = await herdrReads;
    const agents = agentSample?.value;
    const panes = paneSample?.value;
    const now = hostEnv().clock.now();
    if (this.stopped) return;
    if (agents) this.lastGood.set("herdr_agents", agentSample!.observedAt);
    if (panes) this.lastGood.set("herdr_panes", paneSample!.observedAt);
    const unavailable = config.terminalBackend === "herdr" && (!agents || !panes);
    if (unavailable && !this.outage && this.journal) {
      const text = "Herdr observation unavailable. Process verification continues. Wait for reconnect before placement or recovery.";
      this.notify(text);
      await appendTeamEvent(this.teamName, { type: "alert", alertId: `herdr-observation:${hostEnv().random.uuid()}`, from: "team-lead", to: "team-lead", kind: "attention", text }).catch(() => undefined);
    }
    this.outage = unavailable;
    for (;;) {
      let page;
      try { page = readTeamEvents(this.teamName, { afterCursor: this.journalCursor, limit: 100 }); }
      catch { break; } // Journal failure cannot suppress independent source truth.
      for (const event of page.events) {
        if (event.type === "task") this.taskCursors.set(event.actor, event.cursor);
        if (event.type === "worker" && event.carrier) this.lastEvents.set(`${event.membershipId}:${event.carrier.field}`, event);
      }
      this.journalCursor = page.cursor;
      if (!page.truncated) break;
    }
    for (const member of members) {
      if (this.stopped) return;
      const status = statuses.get(member.name) ?? null;
      const probe = status?.pid ? generations.get(status.pid) ?? { kind: "unknown" as const, reason: generationSample.fact ?? "missing_batch_result" } : undefined;
      const view = deriveCarrierView(member, status, generationSample.observedAt, probe);
      if (probe && probe.kind !== "unknown") this.lastGood.set(`generation:${view.membership}`, generationSample.observedAt);
      view.evidence[0].lastGoodAt = this.lastGood.get(`generation:${view.membership}`);
      const prior = priorViews.get(view.membership);
      if (panes && view.paneId) view.terminal = panes.some(row => row.pane_id === view.paneId) ? "present" : "absent";
      const agent = agents?.find(row => row.name === herdrCarrierName(this.teamName, member.name) && row.pane_id === view.paneId && herdrPiSessionPath(row.agent_session) === member.sessionFile);
      if (agent && ["working", "idle", "blocked"].includes(String(agent.agent_status))) view.activity = agent.agent_status as CarrierView["activity"];
      view.evidence.push({ source: "herdr_panes", fact: paneSample?.fact ?? (panes ? view.terminal : "pane_list_unavailable"), observedAt: paneSample?.observedAt ?? now, lastGoodAt: this.lastGood.get("herdr_panes") }, { source: "herdr_agents", fact: agentSample?.fact ?? (agents ? view.activity : "agent_list_unavailable"), observedAt: agentSample?.observedAt ?? now, lastGoodAt: this.lastGood.get("herdr_agents") });
      for (const item of view.evidence) if (item.source === "process_generation" || item.source.startsWith("herdr_")) item.expiresAt = item.observedAt + CARRIER_SAMPLE_TTL_MS;
      this.projection.set(view.membership, view);
      this.expire();
      const samePriorGeneration = !prior || JSON.stringify(prior.generation) === JSON.stringify(view.generation);
      const reloading = samePriorGeneration && (view.process === "live" || view.process === "stopping")
        && (view.lastStop?.piReason === "reload" || (prior?.lastStop?.piReason === "reload" && view.process === "live"));
      for (const field of ["binding", "launch", "process", "terminal"] as const) {
        const historical = this.lastEvents.get(`${view.membership}:${field}`)?.carrier;
        const sameGeneration = JSON.stringify(historical?.generation) === JSON.stringify(view.generation);
        const before = prior?.[field] ?? (historical?.launchId === view.launchId && sameGeneration ? historical?.to : undefined);
        if (view[field] === before || (field === "terminal" && view.terminal !== "absent")) continue;
        if (reloading && field === "process") continue;
        if (!prior && ["none", "unknown", "bound", "live"].includes(view[field])) continue;
        await this.publish(view, field, before ?? "unknown", view[field], status);
      }
      if (samePriorGeneration && view.process === "stopping" && view.lastStop?.piReason === "reload" && now - view.lastStop.observedAt >= 15000) {
        // The transition is suppressed during a normal reload. Emit only once after the hang bound.
        const recorded = this.lastEvents.get(`${view.membership}:process`)?.carrier;
        if (!prior?.evidence.some(e => e.fact === "reload_hung") && !(recorded?.cause.fact === "reload_hung" && recorded.observedAt >= view.lastStop.observedAt + 15000)) await this.publish(view, "process", "live", "stopping", status, "reload_hung");
        view.evidence.push({ source: "session_shutdown", fact: "reload_hung", observedAt: now });
      }
      if (view.binding === "unbound" && ["requested", "started", "unknown"].includes(view.launch)
        && member.launch && now - member.launch.requestedAt >= 15000 && agents && !agent) {
        const recorded = this.lastEvents.get(`${view.membership}:launch`)?.carrier;
        if (recorded?.cause.fact !== "launch_hung" || recorded.launchId !== view.launchId) await this.publish(view, "launch", view.launch, view.launch, status, "launch_hung");
      }
      const attempt = this.taskCursors.get(member.name) ?? "0";
      const block = this.blocked.get(view.membership);
      if (!block || block.attempt !== attempt) this.blocked.set(view.membership, { since: now, emitted: Number(this.lastEvents.get(`${view.membership}:blocked`)?.cursor ?? 0) > Number(attempt), attempt });
      const currentBlock = this.blocked.get(view.membership)!;
      if (view.activity !== "blocked") currentBlock.since = now;
      else if (!currentBlock.emitted && now - currentBlock.since >= 3000) {
        await this.publish(view, "blocked", "unknown", "blocked", status);
        currentBlock.emitted = true;
      }
      this.projection.set(view.membership, view);
    }
  }
  private async publish(view: CarrierView, field: CarrierEvent["field"], from: string, to: string, status: AgentRuntimeStatus | null, attentionFact?: string): Promise<void> {
    if (!this.journal || this.stopped) return;
    const suspectedHumanStop = !status?.stopRequested && (!!view.lastStop?.suspectedHumanStop || view.terminal === "absent");
    const source = field === "terminal" ? "herdr_panes" : field === "blocked" ? "herdr_agents" : field === "process" ? "process_generation" : field === "launch" ? "launch" : "membership";
    const evidence = view.evidence.find(item => item.source === source);
    const cause = field === "process" && view.lastStop && to === "stopping"
      ? { source: "session_shutdown", fact: view.lastStop.piReason }
      : { source, fact: evidence?.fact ?? to };
    if (attentionFact) cause.fact = attentionFact;
    const carrier: CarrierEvent = { membership: view.membership, launchId: view.launchId, generation: view.generation, field, from, to, cause,
      observedAt: attentionFact ? hostEnv().clock.now() : cause.source === "session_shutdown" ? view.lastStop!.observedAt : evidence?.observedAt ?? hostEnv().clock.now(), paneId: view.paneId, suspectedHumanStop,
      nextActionHint: attentionFact || suspectedHumanStop || field === "blocked" || to === "stopping" ? "ask_human" : to === "gone" || to === "refused" ? "ensure_worker" : "wait" };
    // External reads can finish after a successor admits. Fence publication, not source latency.
    await withCurrentMembershipLease(this.teamName, view.membership, async member => {
      const current = await readRuntimeStatus(this.teamName, view.worker);
      if (this.stopped || member.sessionFile !== view.sessionFile || (member.launch?.launchId ?? member.pendingLaunchId) !== view.launchId
        || JSON.stringify(runtimeGeneration(current) ?? undefined) !== JSON.stringify(view.generation)
        || JSON.stringify(current?.lastStop) !== JSON.stringify(status?.lastStop)
        || current?.stopRequested !== status?.stopRequested) return;
      const event = await appendTeamEvent(this.teamName, { type: "worker", worker: view.worker, membershipId: view.membership, phase: "carrier", carrier }) as WorkerTeamEvent;
      this.lastEvents.set(`${view.membership}:${field}`, event);
      this.notify(`Worker ${view.worker}: ${field} ${to} (${cause.source}: ${cause.fact}); pane ${view.paneId ?? "unknown"}; ${carrier.nextActionHint}.`);
    }).catch(() => undefined);
  }
}
