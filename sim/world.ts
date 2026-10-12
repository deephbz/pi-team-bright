import fs from "node:fs";
import path from "node:path";
import { runWithHostEnv, type HostEnv, type HostWatcher } from "../src/env/host-env";
import { createIsolatedWorkspace } from "../test/support/external-harness";
import { Entropy, type Choice } from "./entropy";
import { Scheduler } from "./scheduler";
import { ProcessTable } from "./process-table";
import { ExecRouter, HerdrFake } from "./herdr";
import { HostGuard } from "./host-guard";

export class ActorExit extends Error {
  constructor(readonly actor: string, readonly code: number) { super(`Actor ${actor} exited (${code})`); }
}
interface WatchRegistration { actor: string; directory: string; closed: boolean; listener: (file: string | null) => void; errors: Array<(error: unknown) => void> }

/** A world owns one shared real tree, one host boot, and one operation queue. */
export class SimWorld {
  readonly workspace = createIsolatedWorkspace("ptb-sim-");
  readonly entropy: Entropy;
  readonly scheduler: Scheduler;
  readonly processes = new ProcessTable();
  readonly herdr = new HerdrFake(this.processes);
  readonly exec = new ExecRouter(this.herdr);
  readonly guard: HostGuard;
  readonly envs = new Map<string, HostEnv>();
  readonly history: Array<{ at: number; actor: string; kind: string; value?: unknown }> = [];
  private readonly watches = new Set<WatchRegistration>();

  constructor(seed: number, options: { tape?: readonly number[]; replay?: readonly Choice[] } = {}) {
    this.entropy = new Entropy(seed, options.tape, options.replay);
    this.scheduler = new Scheduler(this.entropy);
    this.guard = new HostGuard(this.workspace.root, file => this.notifyFile(file));
  }
  createActor(actor: string, variables: Record<string, string> = {}): HostEnv {
    if (this.envs.has(actor)) throw new Error(`Actor environment already exists: ${actor}`);
    const process = this.processes.actor(actor) ?? this.processes.spawn(actor);
    const env: HostEnv = {
      clock: this.scheduler.clock(actor, callback => { this.enter(actor, callback); }),
      random: this.entropy,
      process: {
        pid: process.pid,
        env: {
          HOME: this.workspace.home, USERPROFILE: this.workspace.home, TMPDIR: this.workspace.tmp,
          PI_CODING_AGENT_DIR: path.join(this.workspace.home, ".pi", "agent"),
          PI_TEAMS_SESSION_ROOT: path.join(this.workspace.home, ".pi", "teams"),
          PI_AGENT_NAME: actor === "lead" ? "team-lead" : actor,
          HERDR_ENV: "1", HERDR_PANE_ID: `pane:${actor}`, HERDR_TAB_ID: "tab-1", HERDR_WORKSPACE_ID: "workspace-1",
          ...variables,
        },
        pidExists: pid => this.processes.exists(pid),
        generation: pid => this.processes.generation(pid),
        kill: (pid, signal) => { if (signal !== 0) this.killPid(pid); else if (!this.processes.exists(pid)) throw Object.assign(new Error("No such process"), { code: "ESRCH" }); },
        exit: code => { this.killPid(process.pid); throw new ActorExit(actor, code); },
      },
      exec: this.exec,
      watch: { watchDirectory: (directory, listener) => this.watch(actor, directory, listener) },
    };
    this.envs.set(actor, env);
    return env;
  }
  enter<T>(actor: string, action: () => T): T {
    const env = this.envs.get(actor);
    const process = this.processes.actor(actor);
    if (!env || !process?.alive || process.pid !== env.process.pid) throw new Error(`Actor is not live: ${actor}`);
    return runWithHostEnv(env, () => this.guard.run(action));
  }
  enqueue(actor: string, label: string, action: () => unknown, delay = 0): number {
    return this.scheduler.enqueue(label, () => {
      if (!this.processes.actor(actor)?.alive) return;
      return this.enter(actor, action);
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
    for (const watch of this.watches) if (!watch.closed && watch.directory === path.dirname(file)) {
      this.enqueue(watch.actor, `watch:${path.basename(file)}`, () => { if (!watch.closed) watch.listener(path.basename(file)); });
    }
  }
  failWatches(error: unknown): void {
    for (const watch of this.watches) if (!watch.closed) this.enqueue(watch.actor, "watch.error", () => { if (!watch.closed) for (const listener of watch.errors) listener(error); });
  }
  record(actor: string, kind: string, value?: unknown): void { this.history.push({ at: this.scheduler.now, actor, kind, value }); }
  async drain(options?: Parameters<Scheduler["drain"]>[0]): Promise<number> {
    const count = await this.scheduler.drain(options);
    this.guard.assertClean();
    return count;
  }
  dispose(): void { this.guard.dispose(); this.workspace.cleanup(); }
}
