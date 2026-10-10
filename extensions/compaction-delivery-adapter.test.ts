import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiTeamSessionAdapter } from "./pi-team-session-adapter";
import { DELIVERY_HOLD_CHANNEL, EXTERNAL_HOLD_LIMIT_MS } from "./compaction-delivery-gate";
import { PTB_DOCTOR_CUSTOM_TYPE } from "../src/utils/ptb-doctor-command";

/**
 * The adapter owns Pi's compaction hooks and every outbound model message.
 * This drives the real adapter through Pi's hook order with `/ptb doctor`,
 * the one sender that needs no Team.
 */
function adapterHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const eventHandlers = new Map<string, (payload: unknown) => void>();
  const pi: any = {
    events: { on: (channel: string, handler: (payload: unknown) => void) => eventHandlers.set(channel, handler) },
    on: (event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  const adapter = createPiTeamSessionAdapter({
    pi,
    teamSessionLifecycleService: {} as any,
    teamLifecycleService: {} as any,
    getModelToolJourney: () => undefined,
    modelToolBranchIds: () => [],
    projectTrust: () => false,
    lifecyclePublication: { recordWorkerFailed: async () => undefined },
    alertMembership: {} as any,
    taskDeliveryMembership: {} as any,
    taskReadAdapterFactory: {} as any,
    teamQuery: { findLeadTeamForSession: () => null } as any,
    leaderToolNames: new Set(),
    workerToolNames: new Set(),
    refreshAlertToolProjection: () => undefined,
    registerRecoveredWorkerTools: () => undefined,
  });
  adapter.register();
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const ctx = {
    hasUI: true,
    ui: { notify: vi.fn() },
    isIdle: () => true,
    sessionManager: { getSessionId: () => "s", getSessionFile: () => "/tmp/s.jsonl", getLeafId: () => "leaf" },
  };
  const doctor = () => commands.get("ptb")!.handler("doctor", ctx);
  const doctorSends = () => pi.sendMessage.mock.calls.filter(([message]: any[]) => message.customType === PTB_DOCTOR_CUSTOM_TYPE);
  const signal = (payload: unknown) => eventHandlers.get(DELIVERY_HOLD_CHANNEL)?.(payload);
  return { pi, emit, ctx, doctor, doctorSends, handlers, signal };
}

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("adapter compaction delivery gate", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("honors synchronous external signals around native compaction and pickup", async () => {
    const test = adapterHarness();
    test.signal({ holder: "hc-auto-compact", token: "run", active: true });
    await test.doctor();
    expect(test.doctorSends()).toHaveLength(0);
    await test.emit("session_before_compact");
    await test.emit("session_compact");
    await macrotask();
    expect(test.doctorSends()).toHaveLength(0);
    test.signal({ holder: "hc-auto-compact", token: "stale", active: false });
    await macrotask();
    expect(test.doctorSends()).toHaveLength(0);
    test.signal({ holder: "hc-auto-compact", token: "run", active: false });
    await macrotask();
    expect(test.doctorSends()).toHaveLength(1);
  });

  it("warns through ctx.ui.notify on lease expiry and resumes held delivery", async () => {
    vi.useFakeTimers();
    const test = adapterHarness();
    test.signal({ holder: "hc-auto-compact", token: "run", active: true });
    await test.doctor();
    await vi.advanceTimersByTimeAsync(EXTERNAL_HOLD_LIMIT_MS + 1);
    expect(test.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("delivery hold from hc-auto-compact expired after 30 minutes"), "warning");
    expect(test.doctorSends()).toHaveLength(1);
  });

  it("ignores malformed signals and clears external holds on Session tree change", async () => {
    const test = adapterHarness();
    for (const payload of [null, {}, { holder: "hc-auto-compact", token: "run", active: "true" }]) test.signal(payload);
    await test.doctor();
    expect(test.doctorSends()).toHaveLength(1);
    test.signal({ holder: "hc-auto-compact", token: "run", active: true });
    await test.doctor();
    expect(test.doctorSends()).toHaveLength(1);
    await test.emit("session_tree");
    test.signal({ holder: "hc-auto-compact", token: "run", active: false });
    await macrotask();
    expect(test.doctorSends()).toHaveLength(1);
    await test.doctor();
    expect(test.doctorSends()).toHaveLength(2);
  });

  it("subscribes to both compaction end events", () => {
    const test = adapterHarness();
    expect(test.handlers.has("session_compact")).toBe(true);
    expect(test.handlers.has("session_compact_failed")).toBe(true);
  });

  it("holds a model message sent during compaction until Pi finishes compacting", async () => {
    const test = adapterHarness();
    await test.emit("session_before_compact");
    await test.doctor();
    expect(test.doctorSends()).toHaveLength(0);
    expect(test.ctx.ui.notify).toHaveBeenCalledWith("Doctor queued after current turn.", "info");
    await test.emit("session_compact");
    expect(test.doctorSends()).toHaveLength(0);
    await macrotask();
    expect(test.doctorSends()).toHaveLength(1);
    expect(test.doctorSends()[0][1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("releases held messages after a failed or cancelled compaction", async () => {
    const test = adapterHarness();
    await test.emit("session_before_compact");
    await test.doctor();
    await test.emit("session_compact_failed", { reason: "manual", aborted: true });
    await macrotask();
    expect(test.doctorSends()).toHaveLength(1);
  });

  it("sends immediately outside compaction", async () => {
    const test = adapterHarness();
    await test.doctor();
    expect(test.doctorSends()).toHaveLength(1);
  });
});
