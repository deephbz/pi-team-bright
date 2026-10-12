import type { GenerationProbe, ProcessGeneration } from "../src/env/host-env";

export interface SimProcess extends ProcessGeneration { actor: string; alive: boolean; parentPid?: number; command: string }

/** A7: birth tokens distinguish reused pids. Host probe support remains advisory. */
export class ProcessTable {
  bootId = "boot-1";
  private boot = 1;
  private birth = 0;
  private pid = 100;
  readonly history: SimProcess[] = [];

  spawn(actor: string, options: { pid?: number; parentPid?: number; command?: string } = {}): SimProcess {
    if (this.actor(actor)?.alive) throw new Error(`Actor already live: ${actor}`);
    const pid = options.pid ?? ++this.pid;
    if (this.exists(pid)) throw new Error(`PID already live: ${pid}`);
    const process: SimProcess = { actor, pid, bootId: this.bootId, osBirthToken: String(++this.birth), alive: true, parentPid: options.parentPid, command: options.command ?? "pi" };
    this.history.push(process);
    return process;
  }
  actor(actor: string): SimProcess | undefined { return this.history.findLast(p => p.actor === actor); }
  current(pid: number): SimProcess | undefined { return this.history.findLast(p => p.pid === pid && p.bootId === this.bootId && p.alive); }
  exists(pid: number): boolean { return !!this.current(pid); }
  generation(pid: number): GenerationProbe {
    const process = this.current(pid);
    return process ? { kind: "found", generation: { pid, bootId: process.bootId, osBirthToken: process.osBirthToken } } : { kind: "absent" };
  }
  kill(pid: number): void {
    const process = this.current(pid);
    if (!process) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    process.alive = false;
  }
  reuse(deadActor: string, newcomer: string): SimProcess {
    const old = this.actor(deadActor);
    if (!old || old.alive) throw new Error("PID reuse requires a dead process");
    return this.spawn(newcomer, { pid: old.pid });
  }
  reboot(): void {
    for (const process of this.history) process.alive = false;
    this.bootId = `boot-${++this.boot}`;
  }
}
