import { hostEnv, type TimerHandle } from "../env/host-env";

export interface RecipientDeliveryBinding {
  teamName: string;
  recipient: string;
  membershipId: string;
  sessionFile: string;
}

export type DeliveryEngineName = "alert" | "task";
export type DeliveryOperation = "start" | "context" | "acknowledgement" | "scan";
export interface DeliveryDegradation {
  engine: DeliveryEngineName;
  operation: DeliveryOperation;
  message: string;
  observedAt: number;
  /** Absent when the engine will not retry automatically. */
  retryAt?: number;
}
export type DeliveryEngineState = { state: "running"; observedAt: number }
  | ({ state: "degraded" } & DeliveryDegradation);

export interface RecipientDeliveryEngine {
  start(): Promise<void>;
  stop(): void;
  observeContext(messages: readonly unknown[]): Promise<number>;
  commitPresentedAfterSuccessfulTurn(reason: unknown): Promise<number>;
}

export interface RecipientDeliveryPair {
  direct: RecipientDeliveryEngine;
  task: RecipientDeliveryEngine;
}

type Slot = { engine: RecipientDeliveryEngine; running: boolean; generation: number; failures: number; terminal?: boolean; retry?: TimerHandle };
type Activation = { binding: RecipientDeliveryBinding; slots: Record<DeliveryEngineName, Slot>; publication: Promise<void>; checking?: Promise<boolean> };

/** One exact recipient fence; each delivery engine owns an independent failure and retry. */
export class RecipientDeliveryLifecycle {
  private active: Activation | undefined;

  constructor(private readonly dependencies: {
    makePair(binding: RecipientDeliveryBinding, failed: (engine: DeliveryEngineName, error: unknown) => void): RecipientDeliveryPair;
    isCurrentBinding(binding: RecipientDeliveryBinding): Promise<boolean>;
    isTerminal?(error: unknown): boolean;
    publishState?(binding: RecipientDeliveryBinding, engine: DeliveryEngineName, state: DeliveryEngineState): Promise<void>;
  }) {}

  get binding(): RecipientDeliveryBinding | undefined { return this.active?.binding; }

  async activate(binding: RecipientDeliveryBinding): Promise<void> {
    this.deactivate();
    const pair = this.dependencies.makePair(binding, (name, error) => { void this.fail(activation, name, "scan", error); });
    const activation: Activation = { binding, publication: Promise.resolve(), slots: {
      alert: { engine: pair.direct, running: false, generation: 0, failures: 0 },
      task: { engine: pair.task, running: false, generation: 0, failures: 0 },
    } };
    this.active = activation;
    // Preserve initial lease ordering. Each start catches its own failure and
    // selects its retry policy before activation proceeds to the next engine.
    await this.start(activation, "alert");
    await this.start(activation, "task");
  }

  deactivate(): void {
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    for (const slot of Object.values(active.slots)) {
      hostEnv().clock.clearTimeout(slot.retry);
      slot.retry = undefined;
      this.stop(slot);
    }
  }

  async observeContext(messages: readonly unknown[]): Promise<void> {
    await this.forward("context", engine => engine.observeContext(messages));
  }

  async commitPresentedAfterSuccessfulTurn(reason: unknown): Promise<void> {
    await this.forward("acknowledgement", engine => engine.commitPresentedAfterSuccessfulTurn(reason));
  }

  private async current(active: Activation): Promise<boolean> {
    if (this.active !== active) return false;
    const check = active.checking ??= this.dependencies.isCurrentBinding(active.binding);
    let current: boolean;
    try { current = await check; }
    finally { if (active.checking === check) active.checking = undefined; }
    if (this.active !== active) return false;
    if (!current) this.deactivate();
    return current;
  }

  private async start(active: Activation, name: DeliveryEngineName, retry = false): Promise<void> {
    const slot = active.slots[name];
    const generation = slot.generation;
    try {
      if (this.active !== active || (retry && !await this.current(active))) return;
      // Admission validates initial activation. Engines retain their own exact
      // effect fences; only a delayed retry needs another shared binding read.
      await slot.engine.start();
      if (this.active !== active || slot.generation !== generation) return;
      slot.running = true;
      slot.failures = 0;
      await this.publish(active, name, { state: "running", observedAt: hostEnv().clock.now() });
    } catch (error) { if (slot.generation === generation) await this.fail(active, name, "start", error); }
  }

  private async forward(operation: "context" | "acknowledgement", call: (engine: RecipientDeliveryEngine) => Promise<number>): Promise<void> {
    const active = this.active;
    if (!active) return;
    await Promise.all((["alert", "task"] as const).map(async name => {
      const slot = active.slots[name];
      if (!slot.running) return;
      const generation = slot.generation;
      try { if (this.active === active) await call(slot.engine); }
      catch (error) { if (slot.generation === generation) await this.fail(active, name, operation, error); }
    }));
  }

  private async fail(active: Activation, name: DeliveryEngineName, operation: DeliveryOperation, error: unknown): Promise<void> {
    if (this.active !== active) return;
    const slot = active.slots[name];
    if (slot.retry || slot.terminal) return;
    slot.terminal = this.dependencies.isTerminal?.(error) === true;
    this.stop(slot);
    const observedAt = hostEnv().clock.now();
    let retryAt: number | undefined;
    if (!slot.terminal) {
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(slot.failures++, 5));
      retryAt = observedAt + delay;
      slot.retry = hostEnv().clock.setTimeout(() => {
        slot.retry = undefined;
        void this.start(active, name, true);
      }, delay);
      if ("unref" in slot.retry) slot.retry.unref();
    }
    await this.publish(active, name, { state: "degraded", engine: name, operation,
      message: error instanceof Error ? error.message : String(error), observedAt, ...(retryAt === undefined ? {} : { retryAt }) });
  }

  private stop(slot: Slot): void {
    slot.generation += 1;
    slot.running = false;
    try { slot.engine.stop(); }
    catch (error) { console.error("[pi-teams] delivery cleanup failed:", error); }
  }

  private async publish(active: Activation, name: DeliveryEngineName, state: DeliveryEngineState): Promise<void> {
    active.publication = active.publication.then(async () => {
      if (this.active === active) await this.dependencies.publishState?.(active.binding, name, state);
    }).catch(error => { console.error("[pi-teams] delivery state publication failed:", error); });
    await active.publication;
  }
}
