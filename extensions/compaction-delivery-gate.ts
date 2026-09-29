import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi does not queue extension messages while it compacts a Session. A
 * `triggerTurn` send during manual compaction starts a concurrent agent run,
 * and a send during automatic compaction lands beside the summary request.
 * Every Pi Team Bright message to the model passes through this gate, so no
 * delivery path can present a message while compaction runs.
 *
 * Held sends keep their order and flush after Pi finishes its compaction
 * tail. A Session change drops held sends: each delivery owner re-presents
 * from its durable record when it activates on the new Session.
 */
export const COMPACTION_HOLD_LIMIT_MS = 15 * 60_000;

type MessageSink = Pick<ExtensionAPI, "sendMessage" | "appendEntry">;

export interface CompactionDeliveryGateClock {
  defer(callback: () => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: CompactionDeliveryGateClock = {
  defer: (callback) => { setTimeout(callback, 0); },
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CompactionDeliveryGate {
  private compacting = false;
  private flushPending = false;
  private epoch = 0;
  private held: Array<() => void> = [];
  private holdLimit: unknown;
  private readonly openListeners = new Set<() => void>();

  constructor(private readonly options: { clock?: CompactionDeliveryGateClock; holdLimitMs?: number; onError?: (error: unknown) => void } = {}) {}

  private get clock(): CompactionDeliveryGateClock { return this.options.clock ?? systemClock; }

  /** True while compaction runs or held sends wait for their flush. */
  get isClosed(): boolean { return this.compacting || this.flushPending; }

  /** Pi `session_before_compact`. */
  begin(): void {
    this.compacting = true;
    this.epoch++;
    this.clearHoldLimit();
    // Pi versions before `session_compact_failed` report no failed or
    // cancelled compaction. The bound keeps held deliveries from stalling.
    this.holdLimit = this.clock.setTimeout(() => this.end(), this.options.holdLimitMs ?? COMPACTION_HOLD_LIMIT_MS);
  }

  /**
   * Pi `session_compact` or `session_compact_failed`. Pi emits both events
   * before it clears its compaction state, so the flush waits one macrotask.
   */
  end(): void {
    if (!this.compacting) return;
    this.compacting = false;
    this.clearHoldLimit();
    this.flushPending = true;
    const epoch = this.epoch;
    this.clock.defer(() => {
      if (epoch !== this.epoch || this.compacting) return;
      this.flushPending = false;
      const held = this.held;
      this.held = [];
      for (const send of held) {
        try { send(); } catch (error) { this.options.onError?.(error); }
      }
      for (const listener of this.openListeners) listener();
    });
  }

  /** Session start or shutdown: held sends belong to the previous Session. */
  reset(): void {
    this.epoch++;
    this.compacting = false;
    this.flushPending = false;
    this.held = [];
    this.clearHoldLimit();
  }

  /** Run after held sends flush, so deferred work can retry. */
  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  /** Wrap Pi's message port. Entries pass through; model messages wait. */
  sink(pi: MessageSink): MessageSink {
    const sendMessage: MessageSink["sendMessage"] = (message, options) => {
      if (!this.isClosed) return pi.sendMessage(message, options);
      this.held.push(() => pi.sendMessage(message, options));
    };
    return { sendMessage, appendEntry: (customType, data) => pi.appendEntry(customType, data) };
  }

  private clearHoldLimit(): void {
    if (this.holdLimit !== undefined) this.clock.clearTimeout(this.holdLimit);
    this.holdLimit = undefined;
  }
}
