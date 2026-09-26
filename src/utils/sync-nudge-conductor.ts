export type { SyncNudgeDebt } from "../coordination/nudge-debt";
import type { SyncNudgeDebt } from "../coordination/nudge-debt";
import { DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD } from "./sync-liveness-settings";

export interface SyncNudgeConductorClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncNudgeConductorDependencies {
  clock: SyncNudgeConductorClock;
  /** Maximum time from the first eligible observation in one scope. */
  delayMs: number;
  /** Number of canonical unseen changes that triggers delivery before the timer. */
  updateThreshold?: number;
  readDebt: () => Promise<SyncNudgeDebt>;
  isSettled: () => boolean;
  isBusy: () => boolean;
  alreadyPresented: (debtKey: string, branchLineage: readonly string[]) => boolean;
  /** True only when the exact observation was published to Pi. */
  present: (debt: Extract<SyncNudgeDebt, { kind: "eligible" }>) => Promise<boolean> | boolean;
}

/** Schedule one exact observation scope. The debt reader owns authority and provenance. */
export class SyncNudgeConductor {
  private timer: unknown;
  private armedScopeKey?: string;
  private deadlineReached = false;
  private started = false;
  private generation = 0;
  private reconcilePromise?: Promise<void>;
  private reconcilePromiseGeneration?: number;
  private reconcileQueued = false;
  private presentingGeneration?: number;
  private readonly updateThreshold: number;

  constructor(private readonly dependencies: SyncNudgeConductorDependencies) {
    if (!Number.isFinite(dependencies.delayMs) || dependencies.delayMs < 0) throw new Error("Auto sync delay must be a nonnegative finite number.");
    const threshold = dependencies.updateThreshold ?? DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD;
    if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error("Auto sync update threshold must be a positive integer.");
    this.updateThreshold = threshold;
  }

  start(): void {
    this.clearArm();
    this.started = true;
    void this.reconcile(++this.generation);
  }

  stop(): void {
    this.started = false;
    ++this.generation;
    this.clearArm();
    this.reconcileQueued = false;
  }

  /** Call on an authority hint, leader settle, or runtime state change. */
  notify(): void {
    if (this.started) void this.reconcile(this.generation);
  }

  async reconcile(generation = this.generation): Promise<void> {
    if (this.reconcilePromise && this.reconcilePromiseGeneration === generation) {
      this.reconcileQueued = true;
      return this.reconcilePromise;
    }
    const promise = this.reconcileLoop(generation);
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

  private async reconcileLoop(generation: number): Promise<void> {
    do {
      this.reconcileQueued = false;
      await this.reconcileOnce(generation);
    } while (this.reconcileQueued && this.isCurrent(generation));
  }

  private async reconcileOnce(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.presentingGeneration === generation || !this.dependencies.isSettled() || this.dependencies.isBusy()) return;
    let debt: SyncNudgeDebt;
    try { debt = await this.dependencies.readDebt(); } catch { return; }
    if (!this.isCurrent(generation) || this.presentingGeneration === generation || !this.dependencies.isSettled() || this.dependencies.isBusy()) return;
    if (debt.kind !== "eligible") {
      this.clearArm();
      return;
    }
    if (this.dependencies.alreadyPresented(debt.debtKey, debt.branchLineage)) {
      this.clearArm();
      return;
    }
    if (this.armedScopeKey !== debt.scopeKey) {
      this.clearArm();
      this.armedScopeKey = debt.scopeKey;
      this.timer = this.dependencies.clock.setTimeout(() => this.onDeadline(debt.scopeKey, generation), this.dependencies.delayMs);
    }
    if (debt.updateCount < this.updateThreshold && !this.deadlineReached) return;
    this.presentingGeneration = generation;
    try {
      const published = await this.dependencies.present(debt);
      if (published && this.isCurrent(generation)) {
        this.clearArm();
      }
    } catch {
      // A later hint may retry. Failure never marks debt as presented.
    } finally {
      if (this.presentingGeneration === generation) this.presentingGeneration = undefined;
    }
  }

  private onDeadline(scopeKey: string, generation: number): void {
    if (!this.isCurrent(generation) || this.armedScopeKey !== scopeKey) return;
    this.timer = undefined;
    this.deadlineReached = true;
    void this.reconcile(generation);
  }

  private clearArm(): void {
    if (this.timer !== undefined) this.dependencies.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.armedScopeKey = undefined;
    this.deadlineReached = false;
  }
}
