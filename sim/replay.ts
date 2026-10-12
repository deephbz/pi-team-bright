import type { Choice } from "./entropy";
import { SimActor } from "./actor";
import { SimWorld } from "./world";
import { WORLD_TRACE_VERSION, type WorldStep, type WorldTrace } from "./trace-format";

export class WorldReplay {
  readonly actors = new Map<string, SimActor>();
  constructor(readonly world: SimWorld) {
    world.herdr.onStart = pane => {
      const id = pane.env.PI_AGENT_NAME || pane.name!;
      world.scheduler.enqueue(`pi.boot:${id}`, () => {
        const actor = this.addActor(id, pane.env);
        return actor.emit("session_start", { reason: "startup" });
      });
    };
  }
  addActor(id: string, variables: Record<string, string> = {}): SimActor {
    if (this.actors.has(id)) throw new Error(`Actor already loaded: ${id}`);
    const actor = new SimActor(this.world, id, variables);
    actor.initialize();
    this.actors.set(id, actor);
    return actor;
  }
  private actor(id: string): SimActor {
    const actor = this.actors.get(id);
    if (!actor) throw new Error(`Unknown Pi actor: ${id}`);
    return actor;
  }
  async apply(step: WorldStep): Promise<void> {
    const world = this.world;
    switch (step.kind) {
      case "lead.start": {
        const lead = this.actors.get("lead") ?? this.addActor("lead");
        await lead.emit("session_start", { reason: step.reason });
        break;
      }
      case "lead.tool": await this.actor("lead").tool(step.tool, step.args); break;
      case "worker.tool": await this.actor(step.worker).tool(step.tool, step.args); break;
      case "turn.end": await this.actor(step.actor).emit("turn_end", { message: { role: "assistant", stopReason: step.outcome === "settled" ? "stop" : step.outcome }, toolResults: [] }); break;
      case "agent.settled": await this.actor(step.actor).settle(); break;
      case "human.escape": case "human.interrupt": await this.actor(step.actor).emit("turn_end", { message: { role: "assistant", stopReason: "aborted" }, toolResults: [] }); break;
      case "pi.shutdown": {
        // A3: graceful quit emits shutdown before process death. Reload keeps the OS process.
        await this.actor(step.actor).emit("session_shutdown", { reason: step.reason });
        if (step.reason === "quit") world.killPid(world.processes.actor(step.actor)!.pid);
        break;
      }
      case "os.kill": {
        const process = world.processes.actor(step.actor);
        if (!process) throw new Error(`Unknown OS actor: ${step.actor}`);
        // Signals do not synthesize Pi events. A3's graceful path is pi.shutdown.
        world.killPid(process.pid);
        break;
      }
      case "os.pidReuse": world.processes.reuse(step.deadActor, step.newcomer); break;
      case "os.reboot":
        for (const process of world.processes.history) if (process.alive) world.killPid(process.pid);
        world.processes.reboot();
        world.herdr.panes.clear();
        break;
      case "human.closePane": {
        const pane = world.herdr.panes.get(step.pane);
        if (pane) {
          if (world.herdr.agentLive(pane)) world.killPid(pane.agentPid!);
          if (world.processes.exists(pane.shellPid)) world.killPid(pane.shellPid);
        }
        world.herdr.close(step.pane);
        break;
      }
      case "human.typeInPane": throw new Error("Unmodeled shell input: use explicit OS or Pi trace steps");
      case "herdr.agentState": {
        const pane = world.herdr.panes.get(step.pane);
        if (!pane) throw new Error(`Unknown pane: ${step.pane}`);
        pane.state = step.state;
        break;
      }
      case "herdr.restart": world.herdr.available = true; world.herdr.partialList = undefined; break;
      case "clock.advance": world.scheduler.advance(step.ms); break;
      default: { const exhaustive: never = step; throw new Error(`Unsupported world step ${exhaustive}`); }
    }
    world.record("world", step.kind, step);
  }
  async run(trace: WorldTrace): Promise<void> {
    if (trace.version !== WORLD_TRACE_VERSION) throw new Error("Unsupported WorldTrace version");
    const epoch = this.world.scheduler.now;
    let previous = 0;
    for (const [index, input] of trace.steps.entries()) {
      if (!Number.isFinite(input.at) || input.at < previous) throw new Error("Trace times must be finite and non-decreasing");
      previous = input.at;
      const target = epoch + input.at;
      if (target > this.world.scheduler.now) this.world.scheduler.advance(target - this.world.scheduler.now);
      this.world.scheduler.enqueue(`input:${index}:${input.step.kind}`, () => this.apply(input.step));
      await this.world.drain();
    }
    this.world.entropy.assertReplayComplete();
  }
}

export async function replayTrace(trace: WorldTrace, options: { choices?: readonly Choice[]; setup?: (runner: WorldReplay) => void } = {}) {
  const world = new SimWorld(trace.seed, { replay: options.choices });
  try {
    const runner = new WorldReplay(world);
    options.setup?.(runner);
    await runner.run(trace);
    return { choices: world.entropy.choices, decisions: world.scheduler.decisions, history: world.history, assumptions: world.herdr.evidence };
  } finally { world.dispose(); }
}
