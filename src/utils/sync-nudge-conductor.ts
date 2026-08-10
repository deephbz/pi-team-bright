export type { SyncNudgeDebt } from "../coordination/nudge-debt";
import type { SyncNudgeDebt } from "../coordination/nudge-debt";

export interface SyncNudgeConductorClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncNudgeConductorDependencies {
  clock: SyncNudgeConductorClock;
  delayMs: number;
  readDebt: () => Promise<SyncNudgeDebt>;
  isSettled: () => boolean;
  isBusy: () => boolean;
  alreadyPresented: (debtKey: string, branchLineage: readonly string[]) => boolean;
  present: (debt: Extract<SyncNudgeDebt, { kind: "eligible" }>) => Promise<void> | void;
}

/**
 * Event-driven delayed nudge arm/reconcile state. The event source and any
 * bounded authority recheck live outside this class; every arm and fire reads
 * debt again, so the timer never becomes an authority or stale identity.
 */
export class SyncNudgeConductor {
  private timer: unknown;
  private armedKey?: string;
  private started = false;
  private generation = 0;
  private reconcilePromise?: Promise<void>;
  private reconcilePromiseGeneration?: number;

  constructor(private readonly dependencies: SyncNudgeConductorDependencies) {
    if (!Number.isFinite(dependencies.delayMs) || dependencies.delayMs < 0) throw new Error("Sync nudge delay must be a nonnegative finite number.");
  }

  start(): void {
    this.started = true;
    const generation = ++this.generation;
    void this.reconcile(generation);
  }

  stop(): void {
    this.started = false;
    ++this.generation;
    this.clearArm();
  }

  /** Call this for every event, Task revision hint, run-state, or actuation transition. */
  notify(): void {
    if (!this.started) return;
    void this.reconcile(this.generation);
  }

  async reconcile(generation = this.generation): Promise<void> {
    if (this.reconcilePromise && this.reconcilePromiseGeneration === generation) return this.reconcilePromise;
    const promise = this.reconcileInternal(generation);
    this.reconcilePromise = promise;
    this.reconcilePromiseGeneration = generation;
    return promise.finally(() => {
      if (this.reconcilePromise === promise) {
        this.reconcilePromise = undefined;
        this.reconcilePromiseGeneration = undefined;
      }
    });
  }

  private isCurrent(generation: number): boolean {
    return this.started && this.generation === generation;
  }

  private async reconcileInternal(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || !this.dependencies.isSettled() || this.dependencies.isBusy()) return;
    let debt: SyncNudgeDebt;
    try { debt = await this.dependencies.readDebt(); } catch { return; }
    if (!this.isCurrent(generation)) return;
    if (debt.kind !== "eligible") {
      this.clearArm();
      return;
    }
    if (this.dependencies.alreadyPresented(debt.debtKey, debt.branchLineage)) {
      this.clearArm();
      return;
    }
    if (this.armedKey === debt.debtKey) return;
    this.clearArm();
    this.armedKey = debt.debtKey;
    this.timer = this.dependencies.clock.setTimeout(() => { void this.fire(debt.debtKey, generation); }, this.dependencies.delayMs);
  }

  private async fire(expectedDebtKey: string, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    this.timer = undefined;
    this.armedKey = undefined;
    if (!this.dependencies.isSettled() || this.dependencies.isBusy()) return;
    let debt: SyncNudgeDebt;
    try { debt = await this.dependencies.readDebt(); } catch { return; }
    if (!this.isCurrent(generation)) return;
    if (debt.kind !== "eligible" || debt.debtKey !== expectedDebtKey || this.dependencies.alreadyPresented(debt.debtKey, debt.branchLineage)) return;
    try { await this.dependencies.present(debt); } catch { return; }
    if (this.isCurrent(generation)) await this.reconcile(generation);
  }

  private clearArm(): void {
    if (this.timer !== undefined) this.dependencies.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.armedKey = undefined;
  }
}
