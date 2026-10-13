import fs from "node:fs";
import { herdrPiSessionPath } from "./adapters/herdr-session";
import { herdrCarrierName } from "./adapters/herdr-adapter";
import { hostEnv, type TimerHandle, type GenerationProbe } from "./env/host-env";
import { memberTerminalTarget } from "./utils/terminal-target";
import type { Member, TeamConfig, TerminalTarget } from "./team-authority/contracts";
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
  terminalTarget?: TerminalTarget;
  evidence: Array<{ source: string; fact: string; observedAt: number; lastGoodAt?: number; expiresAt?: number }>;
}
export interface CarrierEvent {
  membership: string;
  launchId?: string;
  generation?: RuntimeGeneration;
  field: "binding" | "launch" | "process" | "terminal" | "activity" | "blocked";
  from: string;
  to: string;
  cause: { source: string; fact: string };
  observedAt: number;
  paneId?: string;
  terminalTarget?: TerminalTarget;
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
    paneId: member.terminalTarget?.targetId ?? member.tmuxPaneId, terminalTarget: member.terminalTarget,
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
export const LAUNCH_STALL_MS = 15000;
export function launchIsStalled(member: Member, agents: readonly Record<string, unknown>[] | undefined, now = hostEnv().clock.now()): boolean {
  const paneId = member.terminalTarget?.targetId ?? member.tmuxPaneId;
  return !!(member.launch && ["started", "unknown"].includes(member.launch.state) && now - member.launch.requestedAt >= LAUNCH_STALL_MS
    && paneId && agents && !agents.some(row => row.pane_id === paneId));
}
type SourceSample<T> = { value?: T; observedAt: number; fact?: string };

/** Coordinates isolate independent carrier histories. Legacy pane-only events stay unscoped. */
function publicationKey(view: Pick<CarrierView, "membership" | "generation" | "launchId" | "terminalTarget">, field: CarrierEvent["field"]): string {
  const g = view.generation, t = view.terminalTarget;
  return JSON.stringify([view.membership, g && [g.membershipId, g.pid, g.startedAt, g.osBirthToken, g.bootId], view.launchId,
    field, t && [t.backend, t.kind, t.targetId]]);
}

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
  private readonly publication: CarrierPublication;
  private journal = false;
  private blocked = new Map<string, { since: number; emitted: boolean; attempt: string }>();
  constructor(private readonly teamName: string, private readonly notify: (text: string) => void = () => {}) {
    this.publication = new CarrierPublication(teamName, notify);
  }
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
    const members = config.members.filter(m => m.agentType === "teammate" && m.isActive !== false)
      .map(m => ({ ...m, terminalTarget: memberTerminalTarget(m, config.terminalBackend) }));
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
    try { this.publication.read(); } catch { /* Source projection does not depend on journal availability. */ }
    for (const member of members) {
      if (this.stopped) return;
      const status = statuses.get(member.name) ?? null;
      const probe = status?.pid ? generations.get(status.pid) ?? { kind: "unknown" as const, reason: generationSample.fact ?? "missing_batch_result" } : undefined;
      const view = deriveCarrierView(member, status, generationSample.observedAt, probe);
      if (probe && probe.kind !== "unknown") this.lastGood.set(`generation:${view.membership}`, generationSample.observedAt);
      view.evidence[0].lastGoodAt = this.lastGood.get(`generation:${view.membership}`);
      if (panes && view.paneId) view.terminal = panes.some(row => row.pane_id === view.paneId) ? "present" : "absent";
      const agent = agents?.find(row => row.name === herdrCarrierName(this.teamName, member.name) && row.pane_id === view.paneId && herdrPiSessionPath(row.agent_session) === member.sessionFile);
      if (agent && ["working", "idle", "blocked"].includes(String(agent.agent_status))) view.activity = agent.agent_status as CarrierView["activity"];
      view.evidence.push({ source: "herdr_panes", fact: paneSample?.fact ?? (panes ? view.terminal : "pane_list_unavailable"), observedAt: paneSample?.observedAt ?? now, lastGoodAt: this.lastGood.get("herdr_panes") }, { source: "herdr_agents", fact: agentSample?.fact ?? (agents ? view.activity : "agent_list_unavailable"), observedAt: agentSample?.observedAt ?? now, lastGoodAt: this.lastGood.get("herdr_agents") });
      for (const item of view.evidence) if (item.source === "process_generation" || item.source.startsWith("herdr_")) item.expiresAt = item.observedAt + CARRIER_SAMPLE_TTL_MS;
      this.projection.set(view.membership, view);
      this.expire();
      let accepted = true;
      for (const field of ["binding", "launch", "process", "terminal", "activity"] as const) {
        if ((this.publication.last(view, field)?.carrier?.to ?? "unknown") === view[field]) continue;
        if (!await this.publish(view, field, view[field], status)) { accepted = false; break; }
      }
      if (!accepted) continue;
      if (view.process === "stopping" && view.lastStop?.piReason === "reload" && now - view.lastStop.observedAt >= 15000) {
        await this.publish(view, "process", "stopping", status, "reload_hung");
        view.evidence.push({ source: "session_shutdown", fact: "reload_hung", observedAt: now });
      }
      if (view.binding === "unbound" && launchIsStalled(member, agents, now)) {
        await this.publish(view, "launch", view.launch, status, "launch_stalled");
      }
      const attempt = this.publication.taskCursor(member.name);
      const blockKey = publicationKey(view, "blocked");
      const block = this.blocked.get(blockKey);
      if (!block || block.attempt !== attempt) this.blocked.set(blockKey, { since: now, emitted: false, attempt });
      const currentBlock = this.blocked.get(blockKey)!;
      if (view.activity !== "blocked") currentBlock.since = now;
      else if (!currentBlock.emitted && now - currentBlock.since >= 3000) {
        currentBlock.emitted = await this.publish(view, "blocked", "blocked", status);
      }
      this.projection.set(view.membership, view);
    }
  }
  private async publish(view: CarrierView, field: CarrierEvent["field"], to: string, status: AgentRuntimeStatus | null, attentionFact?: string): Promise<boolean> {
    if (!this.journal || this.stopped) return false;
    return withCurrentMembershipLease(this.teamName, view.membership, async member => {
      if (this.stopped) return false;
      return this.publication.publishUnderLease(member, view, field, to, status, attentionFact, () => this.stopped);
    }).catch(() => false);
  }
}

/** One journal baseline for polling and admission. Callers hold the exact Membership lease. */
class CarrierPublication {
  private journalCursor = "0";
  private taskCursors = new Map<string, string>();
  private lastEvents = new Map<string, WorkerTeamEvent>();
  constructor(private readonly teamName: string, private readonly notify: (text: string) => void = () => {}) {}
  last(view: CarrierView, field: CarrierEvent["field"]): WorkerTeamEvent | undefined { return this.lastEvents.get(publicationKey(view, field)); }
  taskCursor(worker: string): string { return this.taskCursors.get(worker) ?? "0"; }
  read(): void {
    for (;;) {
      const page = readTeamEvents(this.teamName, { afterCursor: this.journalCursor, limit: 100 });
      for (const event of page.events) {
        if (event.type === "task") this.taskCursors.set(event.actor, event.cursor);
        if (event.type === "worker" && event.carrier) this.lastEvents.set(publicationKey(event.carrier, event.carrier.field), event);
      }
      this.journalCursor = page.cursor;
      if (!page.truncated) return;
    }
  }
  async publishUnderLease(member: Member, view: CarrierView, field: CarrierEvent["field"], to: string, status: AgentRuntimeStatus | null, attentionFact?: string, stopped = () => false): Promise<boolean> {
      // No observation checkpoint or unaccepted value can become a publication baseline.
      const current = await readRuntimeStatus(this.teamName, view.worker);
      const coordinates = { membership: member.membershipId ?? "", launchId: member.launch?.launchId ?? member.pendingLaunchId,
        generation: runtimeGeneration(current) ?? undefined, terminalTarget: memberTerminalTarget(member, view.terminalTarget?.backend) };
      const key = publicationKey(view, field);
      if (stopped() || member.sessionFile !== view.sessionFile || publicationKey(coordinates, field) !== key
        || JSON.stringify(current?.lastStop) !== JSON.stringify(status?.lastStop)
        || current?.stopRequested !== status?.stopRequested) return false;
      this.read(); // Fail closed if the accepted baseline cannot be read.
      const recorded = this.lastEvents.get(key);
      const before = recorded?.carrier;
      const from = before?.to ?? "unknown";
      if (attentionFact === "reload_hung") {
        if (before?.cause.fact === attentionFact && before.observedAt >= view.lastStop!.observedAt + 15000) return true;
      } else if (attentionFact === "launch_stalled") {
        if (before?.cause.fact === attentionFact) return true;
      } else if (field === "blocked") {
        if (Number(recorded?.cursor ?? 0) > Number(this.taskCursors.get(view.worker) ?? "0")) return true;
      } else {
        if (from === to) return true;
        // The only suppressed pair is normal reload in these exact generation coordinates.
        // Re-admission clears lastStop; the accepted live baseline then needs no change.
        if (field === "process" && ["live", "stopping"].includes(from) && ["live", "stopping"].includes(to)
          && view.lastStop?.piReason === "reload") return true;
      }
      const quiet = field === "activity" || (field === "terminal" && to !== "absent");
      const suspectedHumanStop = !quiet && !status?.stopRequested && (!!view.lastStop?.suspectedHumanStop || view.terminal === "absent");
      const source = field === "terminal" ? "herdr_panes" : field === "blocked" || field === "activity" ? "herdr_agents" : field === "process" ? "process_generation" : field === "launch" ? "launch" : "membership";
      const evidence = view.evidence.find(item => item.source === source);
      const cause = field === "process" && view.lastStop && to === "stopping"
        ? { source: "session_shutdown", fact: view.lastStop.piReason }
        : { source, fact: evidence?.fact ?? to };
      if (attentionFact) cause.fact = attentionFact;
      const carrier: CarrierEvent = { membership: view.membership, launchId: view.launchId, generation: view.generation, field, from, to, cause,
        observedAt: attentionFact ? hostEnv().clock.now() : cause.source === "session_shutdown" ? view.lastStop!.observedAt : evidence?.observedAt ?? hostEnv().clock.now(),
        paneId: view.paneId, terminalTarget: view.terminalTarget, suspectedHumanStop,
        nextActionHint: quiet ? "wait" : attentionFact || suspectedHumanStop || field === "blocked" || to === "stopping" ? "ask_human" : to === "gone" || to === "refused" ? "ensure_worker" : "wait" };
      await appendTeamEvent(this.teamName, { type: "worker", worker: view.worker, membershipId: view.membership, phase: "carrier", carrier });
      // Consume the receipt through the ordered journal on the next publication. This prevents
      // an older unread event from replacing the accepted value just appended here.
      if (carrier.nextActionHint !== "wait") {
        try { this.notify(`Worker ${view.worker}: ${field} ${to} (${cause.source}: ${cause.fact}); pane ${view.paneId ?? "unknown"}; ${carrier.nextActionHint}.`); } catch { /* UI delivery cannot undo append. */ }
      }
      return true;
  }
}

/** Publish verified predecessor death before admission can overwrite its runtime record.
 * The admission caller holds the Membership lease through publication and replacement.
 */
export async function publishPredecessorExit(teamName: string, member: Member, status: AgentRuntimeStatus, teamBackend?: string): Promise<void> {
  const current = { ...member, terminalTarget: memberTerminalTarget(member, teamBackend) };
  const view = deriveCarrierView(current, status);
  if (view.process !== "gone") throw new Error("Predecessor exit is not verified; runtime replacement cannot proceed.");
  if (!await new CarrierPublication(teamName).publishUnderLease(current, view, "process", "gone", status)) {
    throw new Error("Predecessor coordinates changed; runtime replacement cannot proceed.");
  }
}
