import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { HISTORY_VERSION, actorRef, type HistoryEntry, type HistoryFact, type HistoryOrigin } from "./history";
import { HistoryObserver } from "./history-observer";
import path from "node:path";
import { enterSimulation, runWithHostEnv, type ExecOutcome, type HostEnv, type HostWatcher, type GenerationProbe, type ProcessGeneration } from "../src/env/host-env";
import type { Fault } from "./trace-format";
import { Entropy, type Choice } from "./entropy";
import { Scheduler } from "./scheduler";
import { generationKey, ProcessTable } from "./process-table";
import { ExecRouter, HerdrFake } from "./herdr";
import { HostGuard } from "./host-guard";
import { assumptionEvidence, type FakeEvidence } from "./assumptions";

export class ActorExit extends Error {
  constructor(readonly actor: string, readonly code: number) { super(`Actor ${actor} exited (${code})`); }
}
interface WatchRegistration { actor: string; directory: string; closed: boolean; listener: (file: string | null) => void; errors: Array<(error: unknown) => void> }

/** A world owns one shared real tree, one host boot, and one operation queue. */
export class SimWorld {
  readonly workspace: { root: string; home: string; tmp: string; cleanup: () => void };
  readonly entropy: Entropy;
  readonly scheduler: Scheduler;
  readonly processes = new ProcessTable();
  readonly herdr = new HerdrFake(this.processes, pid => this.killPid(pid));
  readonly exec = new ExecRouter(this.herdr);
  readonly guard: HostGuard;
  readonly envs = new Map<string, HostEnv>();
  readonly faults = new Map<Fault["source"], Fault>();
  private readonly generations = new Map<string, ReturnType<ProcessTable["spawn"]>>();
  private readonly release: () => void;
  private disposed = false;
  readonly history: HistoryEntry[] = [];
  readonly observer: HistoryObserver;
  private readonly origins = new AsyncLocalStorage<HistoryOrigin>();
  private execSequence = 0;
  readonly evidence: FakeEvidence[] = [assumptionEvidence("A7", "PID reuse changes the birth token", "Linux procfs only; the macOS helper has no PID-reuse probe"), assumptionEvidence("A9", "Real filesystem atomic rename and exclusive create under process crash; host-crash durability is unclaimed")];
  private readonly watches = new Set<WatchRegistration>();

  constructor(seed: number, options: { tape?: readonly number[]; replay?: readonly Choice[]; scheduleChoices?: readonly number[] } = {}) {
    const home = process.env.PI_TEAMS_VITEST_HOME;
    const parent = process.env.PI_TEAMS_VITEST_ROOT;
    if (!home || !parent || process.env.HOME !== home || !path.resolve(home).startsWith(`${path.resolve(parent)}${path.sep}`)) {
      throw new Error("Simulation requires the pre-import isolated HOME from test/setup.ts");
    }
    this.release = enterSimulation();
    const wipe = () => { for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true }); };
    wipe();
    this.workspace = { root: home, home, tmp: path.join(home, "tmp"), cleanup: wipe };
    fs.mkdirSync(this.workspace.tmp, { recursive: true });
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ pi_team_bright: { team: { date_prefix: false }, model_roles: { "sim-worker": { model: "synthetic/model", thinking: "off", use: "Deterministic simulation" } }, default_model_role: "sim-worker" } }));
    this.entropy = new Entropy(seed, options.tape, options.replay, options.scheduleChoices);
    this.scheduler = new Scheduler(this.entropy);
    this.guard = new HostGuard(this.workspace.root, file => this.notifyFile(file), file => {
      if (path.basename(file) === "team-events.jsonl") this.observer.sampleJournal(file, fact => this.record(fact));
      if (path.basename(file) === "team-events.jsonl" && this.faults.get("journal")?.mode === "commit_then_error") {
        this.record({ kind: "fault.effect", source: "journal", detail: "fsync committed journal bytes before injected EIO" });
        throw Object.assign(new Error("Injected journal commit-then-error"), { code: "EIO" });
      }
    });
    this.observer = new HistoryObserver(home, fact => this.record(fact, { kind: "observer" }));
    this.record({ kind: "authority.tracing" }, { kind: "setup" });
    this.processes.onChange = (kind, process) => this.record({ kind, process: {
      actorKey: process.actor, command: process.command, parentPid: process.parentPid,
      ...(process.processKind === "worker_pi" ? { processKind: process.processKind, membershipId: process.membershipId } : { processKind: process.processKind }),
      generation: { pid: process.pid, bootId: process.bootId, osBirthToken: process.osBirthToken },
    } });
    this.herdr.onPane = (kind, pane) => this.record({ kind, pane: { paneId: pane.id, shellPid: pane.shellPid, agentPid: pane.agentPid } });
    this.scheduler.onBoundary = (phase, operation) => {
      if (phase === "end") this.observer.sample();
      this.record({ kind: phase === "begin" ? "step.begin" : "step.end", operationId: operation.id, label: operation.label,
        ...(operation.actor ? { actor: actorRef(operation.actor) } : {}) }, { kind: "observer" });
    };
  }
  createActor(actor: string, variables: Record<string, string> = {}): HostEnv {
    if (this.envs.has(actor)) throw new Error(`Actor environment already exists: ${actor}`);
    const membershipId = variables.PI_TEAM_MEMBERSHIP_ID;
    const previous = this.processes.actor(actor);
    const process = (previous?.alive ? previous : undefined) ?? this.processes.spawn(actor, { identity:
      membershipId ? { processKind: "worker_pi", membershipId }
        : { processKind: variables.PI_AGENT_NAME === "team-lead" ? "lead_pi" : "other" },
    });
    this.generations.set(actor, process);
    const env: HostEnv = {
      clock: this.scheduler.clock(actor, callback => process.alive ? this.enter(actor, callback) : undefined),
      random: this.entropy,
      process: {
        pid: process.pid, argv: ["node", "/synthetic/pi.js"], execPath: "/synthetic/node",
        platform: "linux",
        cwd: () => this.workspace.home,
        env: {
          HOME: this.workspace.home, USERPROFILE: this.workspace.home, TMPDIR: this.workspace.tmp,
          PI_CODING_AGENT_DIR: path.join(this.workspace.home, ".pi", "agent"),
          PI_TEAMS_SESSION_ROOT: path.join(this.workspace.home, ".pi", "teams"),
          PI_AGENT_NAME: actor === "lead" ? "team-lead" : actor,
          HERDR_ENV: "1", HERDR_PANE_ID: `pane:${actor}`, HERDR_TAB_ID: "tab-1", HERDR_WORKSPACE_ID: "workspace-1",
          ...variables,
        },
        pidExists: pid => this.processes.exists(pid),
        generation: pid => this.faults.get("generation")?.mode === "unavailable" ? { kind: "unknown", reason: "injected_generation_unavailable" } : this.processes.generation(pid),
        generations: pids => {
          const samples = new Map<number, GenerationProbe>(pids.map(pid => [pid, env.process.generation(pid)]));
          const fault = this.faults.get("generation");
          if (fault?.source !== "generation" || fault.mode !== "slow") return Promise.resolve(samples);
          return new Promise(resolve => this.enqueue(actor, "generation.completion", () => resolve(samples), fault.delayMs ?? 100));
        },
        kill: (pid, signal) => { if (signal !== 0) this.killPid(pid); else if (!this.processes.exists(pid)) throw Object.assign(new Error("No such process"), { code: "ESRCH" }); },
        exit: code => { this.killPid(process.pid); throw new ActorExit(actor, code); },
      },
      exec: {
        runSync: (command, args) => {
          const callId = this.execCall(actor, "sync", command, args);
          return this.withOrigin({ kind: "ptb", actor: actorRef(actor), ...this.callOrigin(), execCallId: callId }, () => {
            try {
              const result = this.execute(command, args);
              this.record({ kind: "exec.result", actor: actorRef(actor), callId, outcome: { kind: "exited", ...result } });
              return result;
            } catch (error) {
              this.record({ kind: "exec.result", actor: actorRef(actor), callId, outcome: { kind: "threw", message: (error as Error).message } });
              throw error;
            }
          });
        },
        run: (command, args, options) => this.runCommand(actor, command, args, options),
      },
      watch: { watchDirectory: (directory, listener) => this.watch(actor, directory, listener) },
    };
    this.envs.set(actor, env);
    const paneId = env.process.env.HERDR_PANE_ID!;
    const pane = this.herdr.panes.get(paneId) ?? this.herdr.spawn(paneId);
    process.parentPid = pane.shellPid;
    pane.agentPid = process.pid;
    pane.agentBootId = process.bootId;
    pane.agentBirthToken = process.osBirthToken;
    pane.name = env.process.env.PI_AGENT_NAME;
    pane.state = "idle";
    return env;
  }
  actorGenerationIsLive(actor: string, expected?: ProcessGeneration): boolean {
    const captured = this.generations.get(actor);
    return captured?.alive === true && (!expected || generationKey(captured) === generationKey(expected));
  }
  enter<T>(actor: string, action: () => T, expected?: ProcessGeneration): T {
    const env = this.envs.get(actor);
    const process = this.processes.actor(actor);
    if (!env || !process?.alive || process !== this.generations.get(actor) || !this.actorGenerationIsLive(actor, expected)) throw new Error(`Actor is not live: ${actor}`);
    const origin = this.origins.getStore();
    return this.withOrigin(origin?.kind === "ptb" && origin.actor.team === actorRef(actor).team && origin.actor.actor === actorRef(actor).actor
      ? origin : { kind: "ptb", actor: actorRef(actor) }, () => runWithHostEnv(env, () => this.guard.run(action)));
  }
  enqueue(actor: string, label: string, action: () => unknown, delay = 0): number {
    const generation = this.generations.get(actor);
    const origin = this.origins.getStore() ?? { kind: "ptb" as const, actor: actorRef(actor) };
    return this.scheduler.enqueue(label, () => {
      if (!generation?.alive || this.generations.get(actor) !== generation) return;
      return this.withOrigin(origin, () => this.enter(actor, action));
    }, { actor, delay });
  }
  killPid(pid: number): void {
    const process = this.processes.current(pid);
    this.processes.kill(pid);
    if (process) {
      this.scheduler.cancelActor(process.actor);
      for (const watch of this.watches) if (watch.actor === process.actor) watch.closed = true;
    }
  }
  private watch(actor: string, directory: string, listener: (file: string | null) => void): HostWatcher {
    // Reuse the filesystem guard for path and symlink validation.
    fs.statSync(directory);
    const registration: WatchRegistration = { actor, directory: path.resolve(directory), listener, closed: false, errors: [] };
    this.watches.add(registration);
    return { close: () => { registration.closed = true; this.watches.delete(registration); }, onError: listener => { registration.errors.push(listener); } };
  }
  notifyFile(file: string): void {
    if (path.basename(file) === "graph-control.json" && path.basename(path.dirname(file)) === "task-authority") {
      this.record({ kind: "authority.write", path: path.relative(this.workspace.home, file) });
    }
    for (const watch of this.watches) if (!watch.closed && watch.directory === path.dirname(file)) {
      this.enqueue(watch.actor, `watch:${path.basename(file)}`, () => { if (!watch.closed) return watch.listener(path.basename(file)); });
    }
  }
  failWatches(error: unknown): void {
    for (const watch of this.watches) if (!watch.closed) this.enqueue(watch.actor, "watch.error", () => { if (!watch.closed) for (const listener of watch.errors) listener(error); });
  }
  withOrigin<T>(origin: HistoryOrigin, action: () => T): T { return this.origins.run(origin, action); }
  private callOrigin(): { toolCallId?: string } {
    const origin = this.origins.getStore();
    return origin?.kind === "ptb" && origin.toolCallId ? { toolCallId: origin.toolCallId } : {};
  }
  record(fact: HistoryFact, origin = this.origins.getStore() ?? { kind: "setup" as const }): void {
    this.history.push(structuredClone({ ...fact, version: HISTORY_VERSION, sequence: this.history.length + 1, at: this.scheduler.now, origin }));
  }
  private execCall(actor: string, mode: "sync" | "async", command: string, args: readonly string[], timeoutMs?: number): string {
    const callId = `exec-${++this.execSequence}`;
    this.record({ kind: "exec.call", actor: actorRef(actor), callId, mode, command, args: [...args], ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    return callId;
  }
  async drain(options?: Parameters<Scheduler["drain"]>[0]): Promise<number> {
    const count = await this.scheduler.drain(options);
    this.observer.sample();
    this.assertClean();
    return count;
  }
  assertClean(): void {
    this.guard.assertClean();
    if (this.exec.failures.length) throw new Error("Unmodeled host behavior", { cause: this.exec.failures[0] });
  }
  private execute(command: string, args: readonly string[]) {
    const binary = path.basename(command);
    if (binary === "herdr" && this.faults.get("herdr")?.mode === "slow") this.scheduler.advance(100); // S-sync-block
    if (binary === "herdr" && args[0] === "agent" && args[1] === "start") {
      const fault = this.faults.get("herdr.start");
      if (fault?.mode === "timeout") this.scheduler.advance(300000); // S-sync-block baseline readiness wait.
      if (fault) return { status: 1, stdout: JSON.stringify({ error: { code: fault.mode === "refused" ? "start_refused" : fault.mode, message: "injected start fault" } }), stderr: "" };
    }
    return this.exec.runSync(command, args);
  }
  private runCommand(actor: string, command: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<ExecOutcome> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new Error("Invalid exec timeout");
    const callId = this.execCall(actor, "async", command, args, options.timeoutMs);
    return this.withOrigin({ kind: "ptb", actor: actorRef(actor), ...this.callOrigin(), execCallId: callId }, () => new Promise(resolve => {
      if (options.signal?.aborted) {
        this.record({ kind: "exec.result", actor: actorRef(actor), callId, outcome: { kind: "aborted" } });
        resolve({ kind: "aborted" }); return;
      }
      let settled = false;
      let effect: ExecOutcome | undefined;
      const finish = (outcome: ExecOutcome) => {
        if (settled) return;
        settled = true;
        this.scheduler.cancel(timeout);
        options.signal?.removeEventListener("abort", abort);
        this.record({ kind: "exec.result", actor: actorRef(actor), callId, outcome });
        resolve(outcome);
      };
      const abort = () => { this.enqueue(actor, "exec.abort", () => finish({ kind: "aborted" })); };
      const timeout = this.enqueue(actor, "exec.timeout", () => finish({ kind: "timeout", afterMs: options.timeoutMs }), options.timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      this.enqueue(actor, "exec.arrival", () => {
        this.enqueue(actor, "exec.effect", () => {
          try {
            // The effect may precede a timeout or abort. Neither outcome proves no effect.
            const startTimeout = path.basename(command) === "herdr" && args[0] === "agent" && args[1] === "start" && this.faults.get("herdr.start")?.mode === "timeout";
            if (startTimeout) {
              if (this.entropy.choose("fault.start.timeout.effect", 2) === 1) {
                const result = this.exec.runSync(command, args);
                this.record({ kind: "exec.effect", actor: actorRef(actor), callId, result });
              }
              return;
            }
            // Slow async calls delay completion without freezing other actors.
            const binary = path.basename(command);
            const slow = binary === "herdr" && this.faults.get(binary)?.mode === "slow";
            const result = slow ? this.exec.runSync(command, args) : this.execute(command, args);
            effect = { kind: "exited", ...result };
            this.record({ kind: "exec.effect", actor: actorRef(actor), callId, result });
            const herdrFault = this.faults.get("herdr");
            const delay = slow ? (binary === "herdr" && herdrFault?.source === "herdr" ? herdrFault.delayMs ?? 100 : 100) : 0;
            this.enqueue(actor, "exec.completion", () => finish(effect!), delay);
          } catch (error) {
            if (!settled) {
              settled = true;
              this.scheduler.cancel(timeout);
              options.signal?.removeEventListener("abort", abort);
              this.record({ kind: "exec.result", actor: actorRef(actor), callId, outcome: { kind: "threw", message: (error as Error).message } });
            }
            throw error;
          }
        });
      });
    }));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.guard.dispose(); this.workspace.cleanup(); this.release();
  }
}
