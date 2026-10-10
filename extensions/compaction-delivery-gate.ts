import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi does not queue extension messages while it compacts a Session. A
 * `triggerTurn` send during manual compaction starts a concurrent agent run,
 * and a send during automatic compaction lands beside the summary request.
 * Every Pi Team Bright message to the model passes through this gate. Native
 * compaction and token-keyed external delivery holds have separate leases.
 * Delivery waits until every hold clears or expires.
 *
 * Held sends keep their order and flush after Pi finishes its compaction
 * tail. A Session change drops held sends: each delivery owner re-presents
 * from its durable record when it activates on the new Session.
 */
export const COMPACTION_HOLD_LIMIT_MS = 15 * 60_000;
export const EXTERNAL_HOLD_LIMIT_MS = 30 * 60_000;
export const DELIVERY_HOLD_CHANNEL = "hc.delivery-hold";

export interface DeliveryHoldSignal { holder: string; token: string; active: boolean }

export function isDeliveryHoldSignal(value: unknown): value is DeliveryHoldSignal {
  if (!value || typeof value !== "object") return false;
  const signal = value as Partial<DeliveryHoldSignal>;
  return typeof signal.holder === "string" && signal.holder.trim().length > 0
    && typeof signal.token === "string" && signal.token.trim().length > 0
    && typeof signal.active === "boolean";
}

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
  private readonly externalHolds = new Map<string, { holder: string; timer: unknown }>();

  constructor(private readonly options: {
    clock?: CompactionDeliveryGateClock;
    holdLimitMs?: number;
    externalHoldLimitMs?: number;
    onExternalHoldExpired?: (holder: string, token: string) => void;
    onError?: (error: unknown) => void;
  } = {}) {}

  private get clock(): CompactionDeliveryGateClock { return this.options.clock ?? systemClock; }

  /** True while any owner holds delivery or sends wait for their flush. */
  get isClosed(): boolean { return this.hasHold || this.flushPending; }

  private get hasHold(): boolean { return this.compacting || this.externalHolds.size > 0; }

  /** A repeated begin renews this token's lease without releasing delivery. */
  beginExternal(holder: string, token: string): void {
    const previous = this.externalHolds.get(token);
    if (previous && previous.holder !== holder) return;
    if (previous) this.clock.clearTimeout(previous.timer);
    this.epoch++;
    const hold = { holder, timer: undefined as unknown };
    this.externalHolds.set(token, hold);
    hold.timer = this.clock.setTimeout(() => {
      if (this.externalHolds.get(token) !== hold) return;
      this.externalHolds.delete(token);
      this.scheduleFlush();
      this.options.onExternalHoldExpired?.(holder, token);
    }, this.options.externalHoldLimitMs ?? EXTERNAL_HOLD_LIMIT_MS);
  }

  /** Only the exact holder and token can release an external hold. */
  endExternal(holder: string, token: string): void {
    const hold = this.externalHolds.get(token);
    if (!hold || hold.holder !== holder) return;
    this.clock.clearTimeout(hold.timer);
    this.externalHolds.delete(token);
    this.scheduleFlush();
  }

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
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.hasHold) return;
    this.flushPending = true;
    const epoch = ++this.epoch;
    this.clock.defer(() => {
      if (epoch !== this.epoch || this.hasHold) return;
      while (this.held.length && epoch === this.epoch && !this.hasHold) {
        const send = this.held.shift()!;
        try { send(); } catch (error) { this.options.onError?.(error); }
      }
      if (epoch === this.epoch && !this.hasHold) {
        this.flushPending = false;
        for (const listener of this.openListeners) listener();
      }
    });
  }

  /** Session start or shutdown: held sends belong to the previous Session. */
  reset(): void {
    this.epoch++;
    this.compacting = false;
    this.flushPending = false;
    this.held = [];
    this.clearHoldLimit();
    for (const hold of this.externalHolds.values()) this.clock.clearTimeout(hold.timer);
    this.externalHolds.clear();
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
