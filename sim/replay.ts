import type { Choice } from "./entropy";
import { SimActor } from "./actor";
import { loadActorExtension } from "./actor-loader";
import { assumptionEvidence } from "./assumptions";
import { SimWorld } from "./world";
import { WORLD_TRACE_VERSION, type ActorRef, type Fault, type ReplayReceipt, type WorldStep, type WorldTrace } from "./trace-format";

export const RUNNER_VERSION = "sim-c1/2";
export function actorKey(who: ActorRef): string { return `${who.team}/${who.actor}`; }

/** Resolve only explicit references. Stale literal versions remain stale. */
export function resolveResultRefs(value: unknown, results: ReadonlyMap<number, unknown>): unknown {
  if (Array.isArray(value)) return value.map(item => resolveResultRefs(item, results));
  if (!value || typeof value !== "object") return value;
  if ("$fromStep" in value && "path" in value) {
    const ref = value as { $fromStep: number; path: string };
    if (!results.has(ref.$fromStep)) throw new Error(`Result unavailable for step ${ref.$fromStep}`);
    let selected = results.get(ref.$fromStep);
    for (const key of ref.path.split(".").filter(Boolean)) {
      if (!selected || typeof selected !== "object" || !Object.hasOwn(selected, key)) throw new Error(`Result path unavailable: ${ref.path}`);
      selected = (selected as Record<string, unknown>)[key];
    }
    return structuredClone(selected);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveResultRefs(item, results)]));
}

export class WorldReplay {
  readonly actors = new Map<string, SimActor>();
  readonly results = new Map<number, unknown>();
  readonly sessionRefs = new Map<string, string>();
  private readonly factories = new Map<string, Awaited<ReturnType<typeof loadActorExtension>>>();
  constructor(readonly world: SimWorld) {
    world.herdr.onStart = pane => {
      const who = { team: pane.env.PI_TEAM_NAME || "team", actor: pane.env.PI_AGENT_NAME || pane.name! };
      const generation = world.processes.current(pane.agentPid!);
      world.scheduler.enqueue(`pi.boot:${actorKey(who)}`, () => {
        if (!generation?.alive || world.faults.get("pi.start")?.mode === "hang") return;
        const actor = this.addActor(who, { ...pane.env, HERDR_PANE_ID: pane.id });
        if (world.faults.get("pi.start")?.mode === "exit_before_ready") { world.killPid(world.envs.get(actor.id)!.process.pid); return; }
        return actor.emit("session_start", { reason: "startup" });
      });
    };
  }
  addActor(who: ActorRef, variables: Record<string, string> = {}): SimActor {
    const id = actorKey(who);
    if (this.actors.has(id)) throw new Error(`Actor already loaded: ${id}`);
    const actor = new SimActor(this.world, id, { ...(who.actor === "lead" ? {} : { PI_TEAM_NAME: who.team }), PI_AGENT_NAME: who.actor === "lead" ? "team-lead" : who.actor, ...variables });
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`Actor module graph was not prepared: ${id}`);
    actor.initialize(factory);
    this.actors.set(id, actor);
    return actor;
  }
  private actor(who: ActorRef): SimActor {
    const actor = this.actors.get(actorKey(who));
    if (!actor) throw new Error(`Unknown Pi actor: ${actorKey(who)}`);
    return actor;
  }
  private fault(fault: Fault): void {
    this.world.faults.set(fault.source, fault);
    if (fault.source === "herdr") {
      this.world.herdr.available = fault.mode !== "unavailable";
      this.world.herdr.partialList = fault.mode === "partial_list" ? new Set() : undefined;
    }
  }
  async apply(step: WorldStep, index: number): Promise<void> {
    const world = this.world;
    switch (step.kind) {
      case "pi.start": {
        if (world.faults.get("pi.start")?.mode === "hang") break;
        const actor = this.actors.get(actorKey(step.who)) ?? this.addActor(step.who);
        this.sessionRefs.set(step.session, actor.session.getSessionId());
        if (world.faults.get("pi.start")?.mode === "exit_before_ready") { world.killPid(world.envs.get(actor.id)!.process.pid); break; }
        await actor.emit("session_start", { reason: step.reason });
        break;
      }
      case "tool.call": this.results.set(index, await this.actor(step.who).tool(step.tool, resolveResultRefs(step.args, this.results) as Record<string, unknown>)); break;
      case "turn.end": await this.actor(step.who).emit("turn_end", { message: { role: "assistant", stopReason: step.outcome === "settled" ? "stop" : step.outcome }, toolResults: [] }); break;
      case "agent.settled": await this.actor(step.who).settle(); break;
      case "human.escape": case "human.interrupt": await this.actor(step.who).emit("turn_end", { message: { role: "assistant", stopReason: "aborted" }, toolResults: [] }); break;
      case "pi.compact": {
        const actor = this.actor(step.who);
        await actor.emit("session_before_compact");
        const first = actor.session.getBranch()[0]?.id;
        if (first) actor.session.appendCompaction("synthetic compaction", first, 0);
        await actor.emit("session_compact");
        break;
      }
      case "pi.tree": {
        const actor = this.actor(step.who);
        await actor.emit("session_before_tree");
        actor.session.branch(step.targetEntry);
        await actor.emit("session_tree");
        break;
      }
      case "pi.fork": throw new Error("Pi cross-Session fork allocation is not modeled yet");
      case "pi.newSession": {
        const actor = this.actor(step.who);
        await actor.emit("session_before_switch", { reason: "new" });
        await actor.emit("session_shutdown", { reason: "new" });
        actor.session.newSession();
        this.sessionRefs.set(step.newSession, actor.session.getSessionId());
        await actor.emit("session_start", { reason: "new" });
        break;
      }
      case "pi.shutdown": {
        world.evidence.push(assumptionEvidence("A3", "Graceful quit emits shutdown before process death"));
        const actor = this.actor(step.who);
        await actor.emit("session_shutdown", { reason: step.reason });
        if (step.reason === "quit") world.killPid(world.envs.get(actor.id)!.process.pid);
        break;
      }
      case "os.kill": {
        const process = world.processes.actor(actorKey(step.who));
        if (!process) throw new Error(`Unknown OS actor: ${actorKey(step.who)}`);
        world.killPid(process.pid);
        break;
      }
      case "os.pidReuse": world.processes.reuse(actorKey(step.dead), step.newcomer); break;
      case "os.reboot":
        for (const process of world.processes.history) if (process.alive) world.killPid(process.pid);
        world.processes.reboot(); world.herdr.panes.clear(); break;
      case "human.closePane": world.herdr.close(step.pane); break;
      case "human.typeInPane":
        if (!world.herdr.panes.has(step.pane)) throw new Error(`Unknown pane: ${step.pane}`);
        // Input is terminal data. Process effects need explicit OS inputs; no shell interpreter runs.
        world.record("terminal", "input", { pane: step.pane, text: step.text });
        break;
      case "herdr.agentState": {
        const pane = world.herdr.panes.get(step.pane);
        if (!pane) throw new Error(`Unknown pane: ${step.pane}`);
        pane.state = step.state;
        break;
      }
      case "herdr.restart": world.herdr.available = true; world.herdr.partialList = undefined; break;
      case "fault.set": this.fault(step.fault); break;
      case "fault.clear":
        world.faults.delete(step.source);
        if (step.source === "herdr") { world.herdr.available = true; world.herdr.partialList = undefined; }
        break;
      default: { const exhaustive: never = step; throw new Error(`Unsupported world step ${exhaustive}`); }
    }
    world.record("world", step.kind, step);
  }
  async run(trace: WorldTrace, bounds: ReplayReceipt["bounds"] = { maxSteps: 10000, maxVirtualMs: 3600000 }): Promise<void> {
    if (trace.version !== WORLD_TRACE_VERSION) throw new Error("Unsupported WorldTrace version");
    if (trace.setup.teams.length) throw new Error("Pre-existing Team setup needs a public-tool bootstrap trace");
    // Native module loading finishes before the deterministic scheduler starts.
    for (const { step } of trace.steps) if ("who" in step) {
      const actors = [step.who];
      if (step.kind === "tool.call" && step.tool === "ensure_worker" && typeof step.args.name === "string") actors.push({ team: step.who.team, actor: step.args.name });
      for (const who of actors) if (!this.factories.has(actorKey(who))) this.factories.set(actorKey(who), await loadActorExtension({ PI_AGENT_NAME: who.actor === "lead" ? "team-lead" : who.actor }));
    }
    const epoch = this.world.scheduler.now;
    const check = () => {
      if (this.world.scheduler.decisions.length > bounds.maxSteps || this.world.scheduler.now - epoch > bounds.maxVirtualMs) throw new Error("Replay bound exceeded");
    };
    let previous = 0;
    for (const [index, input] of trace.steps.entries()) {
      if (!Number.isFinite(input.at) || input.at < previous) throw new Error("Trace times must be finite and non-decreasing");
      previous = input.at;
      const target = epoch + input.at;
      // Timers due before this input must run at their own virtual deadlines.
      while ((this.world.scheduler.nextDue() ?? Infinity) <= target) {
        check();
        await this.world.scheduler.step(true);
      }
      if (target > this.world.scheduler.now) this.world.scheduler.advance(target - this.world.scheduler.now);
      this.world.scheduler.enqueue(`input:${index}:${input.step.kind}`, () => this.apply(input.step, index));
      await this.world.drain({ maxSteps: Math.max(1, bounds.maxSteps - this.world.scheduler.decisions.length) });
      check();
    }
    while (this.world.scheduler.pendingCount() > 0) {
      check();
      if (!await this.world.scheduler.step(true)) throw new Error("Replay has an unfinished operation without a scheduled completion");
    }
    check();
    this.world.assertClean();
    this.world.entropy.assertReplayComplete();
  }
}

export async function replayTrace(trace: WorldTrace, options: { seed?: number; receipt?: ReplayReceipt; choices?: readonly Choice[]; setup?: (runner: WorldReplay) => void } = {}) {
  if (options.receipt && (options.receipt.traceId !== trace.id || options.receipt.runnerVersion !== RUNNER_VERSION)) throw new Error("Receipt does not identify this trace and runner");
  const seed = options.receipt?.seed ?? options.seed ?? 0;
  const bounds = options.receipt?.bounds ?? { maxSteps: 10000, maxVirtualMs: 3600000 };
  const world = new SimWorld(seed, { replay: options.choices, scheduleChoices: options.receipt?.choices });
  try {
    const runner = new WorldReplay(world);
    options.setup?.(runner);
    await runner.run(trace, bounds);
    const receipt: ReplayReceipt = { traceId: trace.id, runnerVersion: RUNNER_VERSION, seed, choices: world.entropy.choices.filter(choice => choice.label === "schedule").map(choice => choice.value), bounds };
    return {
      receipt, choices: world.entropy.choices, decisions: world.scheduler.decisions, history: world.history,
      assumptions: [...world.evidence, ...world.herdr.evidence],
      processes: structuredClone(world.processes.history),
      panes: [...world.herdr.panes.values()].map(pane => ({ id: pane.id, shellPid: pane.shellPid, agentPid: pane.agentPid, agentLive: world.herdr.agentLive(pane) })),
      actors: [...runner.actors.values()].map(actor => ({ id: actor.id, sessionId: actor.session.getSessionId(), tools: [...actor.tools.keys()], branch: actor.session.getBranch() })),
    };
  } finally { world.dispose(); }
}
