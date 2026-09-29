import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiTeamSessionAdapter } from "./pi-team-session-adapter";
import { PTB_DOCTOR_CUSTOM_TYPE } from "../src/utils/ptb-doctor-command";

/**
 * The adapter owns Pi's compaction hooks and every outbound model message.
 * This drives the real adapter through Pi's hook order with `/ptb doctor`,
 * the one sender that needs no Team.
 */
function adapterHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const pi: any = {
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
  return { pi, emit, ctx, doctor, doctorSends, handlers };
}

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("adapter compaction delivery gate", () => {
  afterEach(() => vi.restoreAllMocks());

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
