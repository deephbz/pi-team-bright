export interface RecipientDeliveryBinding {
  teamName: string;
  recipient: string;
  membershipId: string;
  sessionFile: string;
}

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

/**
 * The one Pi-Session actuator for an exact recipient Membership. Delivery
 * engines retain their own watch, replay, acknowledgement, and fencing rules;
 * this small adapter only makes their Session lifecycle atomic as a pair.
 */
export class RecipientDeliveryLifecycle {
  private pair: RecipientDeliveryPair | undefined;
  private pendingPair: RecipientDeliveryPair | undefined;
  private activeBinding: RecipientDeliveryBinding | undefined;
  private generation = 0;
  private readonly stoppedPairs = new WeakSet<RecipientDeliveryPair>();

  constructor(private readonly dependencies: { makePair(binding: RecipientDeliveryBinding): RecipientDeliveryPair }) {}

  get binding(): RecipientDeliveryBinding | undefined {
    return this.activeBinding;
  }

  async activate(binding: RecipientDeliveryBinding): Promise<void> {
    const generation = ++this.generation;
    this.unbind();
    const pair = this.dependencies.makePair(binding);
    this.pendingPair = pair;
    try {
      await pair.direct.start();
      if (!this.isCurrent(generation, pair)) return;
      await pair.task.start();
      if (!this.isCurrent(generation, pair)) return;
      this.pendingPair = undefined;
      this.pair = pair;
      this.activeBinding = binding;
    } catch (error) {
      if (this.pendingPair === pair) this.pendingPair = undefined;
      this.stopPair(pair);
      throw error;
    }
  }

  deactivate(): void {
    this.generation += 1;
    this.unbind();
  }

  async observeContext(messages: readonly unknown[]): Promise<void> {
    const generation = this.generation;
    const pair = this.pair;
    if (!pair) return;
    await pair.direct.observeContext(messages);
    if (!this.isCurrent(generation, pair)) return;
    await pair.task.observeContext(messages);
  }

  async commitPresentedAfterSuccessfulTurn(reason: unknown): Promise<void> {
    const generation = this.generation;
    const pair = this.pair;
    if (!pair || !this.isCurrent(generation, pair)) return;
    // Preserve the Session adapter's existing concurrent successful-turn
    // callback behavior while keeping pair ownership internal.
    await Promise.all([
      pair.direct.commitPresentedAfterSuccessfulTurn(reason),
      pair.task.commitPresentedAfterSuccessfulTurn(reason),
    ]);
  }

  private isCurrent(generation: number, pair: RecipientDeliveryPair): boolean {
    return this.generation === generation && (this.pair === pair || this.pendingPair === pair);
  }

  private unbind(): void {
    const active = this.pair;
    const pending = this.pendingPair;
    this.pair = undefined;
    this.pendingPair = undefined;
    this.activeBinding = undefined;
    if (active) this.stopPair(active);
    if (pending) this.stopPair(pending);
  }

  private stopPair(pair: RecipientDeliveryPair): void {
    if (this.stoppedPairs.has(pair)) return;
    this.stoppedPairs.add(pair);
    pair.direct.stop();
    pair.task.stop();
  }
}
