import type { HostClock, TimerHandle } from "../src/env/host-env";
import { Entropy } from "./entropy";

type Operation = { id: number; label: string; actor?: string; due: number; run: () => unknown; interval?: number };
export interface Decision { at: number; enabled: string[]; selected: string }

/** The sole scheduler. Promise jobs drain between choices; no host I/O may run underneath it. */
export class Scheduler {
  now = 1_700_000_000_000;
  readonly decisions: Decision[] = [];
  onBoundary?: (phase: "begin" | "end", operation: { id: number; label: string; actor?: string }) => void;
  private nextId = 0;
  private readonly queue = new Map<number, Operation>();
  private readonly pending = new Map<Promise<unknown>, string | undefined>();
  private readonly errors: unknown[] = [];

  constructor(readonly entropy: Entropy) {}

  enqueue(label: string, run: () => unknown, options: { actor?: string; delay?: number; interval?: number } = {}): number {
    const delay = options.delay ?? 0;
    if (!Number.isFinite(delay) || delay < 0) throw new Error("Invalid operation delay");
    const id = ++this.nextId;
    this.queue.set(id, { id, label, run, actor: options.actor, due: this.now + delay, interval: options.interval });
    return id;
  }

  cancel(id: number): void { this.queue.delete(id); }
  cancelActor(actor: string): void {
    for (const operation of this.queue.values()) if (operation.actor === actor) this.cancel(operation.id);
    for (const [promise, owner] of this.pending) if (owner === actor) this.pending.delete(promise);
  }
  enabled(): string[] {
    return [...this.queue.values()].filter(op => op.due <= this.now).map(op => `${op.id}:${op.label}`);
  }
  pendingCount(): number { return this.pending.size; }
  nextDue(): number | undefined {
    return this.queue.size ? Math.min(...[...this.queue.values()].map(op => op.due)) : undefined;
  }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("Clock must advance by a finite nonnegative duration");
    this.now += ms;
  }

  // A fixed checkpoint budget is explicit. Native I/O and an unbounded promise chain are unsupported.
  async checkpoint(): Promise<void> {
    for (let i = 0; i < 64; i++) await Promise.resolve();
    if (this.errors.length) throw this.errors.shift();
  }

  async step(advanceTime = false): Promise<boolean> {
    await this.checkpoint();
    let enabled = this.enabled();
    if (!enabled.length && advanceTime && this.queue.size) {
      this.now = Math.min(...[...this.queue.values()].map(op => op.due));
      enabled = this.enabled();
    }
    if (!enabled.length) return false;
    const selected = enabled[this.entropy.choose("schedule", enabled.length, enabled)]!;
    const id = Number(selected.split(":", 1)[0]);
    const op = this.queue.get(id)!;
    this.queue.delete(id);
    if (op.interval !== undefined) this.queue.set(id, { ...op, due: this.now + op.interval });
    this.decisions.push({ at: this.now, enabled, selected });
    this.onBoundary?.("begin", op);
    try {
      const result = op.run();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        const pending = Promise.resolve(result);
        this.pending.set(pending, op.actor);
        pending.then(() => this.pending.delete(pending), error => {
          const active = this.pending.delete(pending);
          if (active) this.errors.push(error);
        });
      }
    } catch (error) { this.errors.push(error); }
    try { await this.checkpoint(); }
    finally { this.onBoundary?.("end", op); }
    return true;
  }

  async drain(options: { maxSteps?: number; advanceTime?: boolean } = {}): Promise<number> {
    const max = options.maxSteps ?? 10000;
    let count = 0;
    while (count < max && await this.step(options.advanceTime)) count++;
    if (count === max && this.enabled().length) throw new Error(`Scheduler step bound ${max} reached`);
    if (this.pending.size && !this.queue.size) throw new Error("Uncontrolled promise or deadlock: no scheduled completion");
    return count;
  }

  clock(actor: string, enter: (callback: () => void) => void): HostClock {
    const schedule = (callback: () => void, ms: number, interval?: number) => ({ id: this.enqueue(
      interval === undefined ? "timer.timeout" : "timer.interval", () => enter(callback),
      { actor, delay: Math.max(0, ms), interval },
    ), unref() {} }) as unknown as TimerHandle;
    const clear = (handle: TimerHandle | undefined) => { if (handle) this.cancel((handle as unknown as { id: number }).id); };
    return {
      now: () => this.now,
      yield: () => new Promise<void>(resolve => { schedule(resolve, 0); }),
      setTimeout: (callback, ms) => schedule(callback, ms), clearTimeout: clear,
      setInterval: (callback, ms) => schedule(callback, Math.max(1, ms), Math.max(1, ms)), clearInterval: clear,
      sleepSync: ms => { this.advance(ms); }, // S-sync-block: no other actor runs during this call.
      sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
        const error = () => Object.assign(new Error("Sleep aborted"), { name: "AbortError" });
        if (signal?.aborted) { reject(error()); return; }
        const handle = schedule(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
        const abort = () => {
          this.enqueue("sleep.abort", () => enter(() => {
            clear(handle);
            signal?.removeEventListener("abort", abort);
            reject(error());
          }), { actor });
        };
        signal?.addEventListener("abort", abort, { once: true });
      }),
    };
  }
}
