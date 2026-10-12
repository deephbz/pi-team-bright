import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamUpdateController, TEAM_UPDATE_TYPE } from "./team-update";
import { CompactionDeliveryGate } from "./compaction-delivery-gate";
import type { BranchEntry } from "../src/coordination/branch-observation";

function fixture() {
  const branch: BranchEntry[] = [{ id: "root", type: "message" }];
  let busy = false, binding = "lead", session = "session";
  let pending: any;
  const result = { kind: "updates", team_changes: [], worker_changes: [{ worker: "worker", scope: "work", kind: "created", text: "Worker created." }], task_changes: [], alerts: [] };
  const send = vi.fn((message: any) => { branch.push({ id: "update", type: "custom_message", ...message }); });
  const gate = new CompactionDeliveryGate();
  const pi = gate.sink({ sendMessage: send, appendEntry: vi.fn() });
  const execute = vi.fn(async (_id: string, _view: string, _signal: AbortSignal, call: string) => {
    pending = { toolCallId: call, observation: { team: "team", epoch: "epoch", binding: "lead", from: 0, through: 1 } }; return result;
  });
  const controller = new TeamUpdateController({ pi,
    current: () => ({ sessionId: session, sessionFile: "/sessions/lead", branch: [...branch] }),
    executeNow: execute,
    readTeamBinding: async () => ({ epochId: "epoch", membershipId: binding }),
    pendingObservation: () => pending,
    setBranchEntries: (_session, entries) => { if (entries.some(entry => entry.customType === TEAM_UPDATE_TYPE)) pending = undefined; },
    clearPending: () => { pending = undefined; },
    isBusy: () => busy,
    notify: vi.fn(),
  });
  return { controller, branch, send, execute, gate, pending: () => pending, busy: (next: boolean) => { busy = next; }, binding: (next: string) => { binding = next; }, session: (next: string) => { session = next; } };
}
afterEach(() => vi.useRealTimers());
describe("idle Team update publisher", () => {
  it("appends a native custom message with one page stamp and no synthetic call or ACK", async () => {
    const fx = fixture();
    expect(await fx.controller.execute("team", "automatic")).toBe("published");
    expect(fx.send).toHaveBeenCalledWith(expect.objectContaining({ customType: "ptb.team-update", details: { team: "team", epoch: "epoch", binding: "lead", from: 0, through: 1 } }), { triggerTurn: true, deliverAs: "followUp" });
    expect(fx.branch).toHaveLength(2);
    expect(JSON.parse(fx.branch[1].content as string)).toMatchObject({ kind: "updates" });
    expect(fx.pending()).toBeUndefined();
  });
  it("does not publish while the Session is busy", async () => {
    const fx = fixture(); fx.busy(true);
    expect(await fx.controller.execute("team", "automatic")).toBe("skipped");
    expect(fx.execute).not.toHaveBeenCalled();
  });
  it("allows only one publisher while an authority read is in flight", async () => {
    const fx = fixture(); let release!: () => void;
    fx.execute.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { kind: "quiet" } as any; });
    const first = fx.controller.execute("team", "automatic"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await fx.controller.execute("team", "command")).toBe("skipped");
    release(); expect(await first).toBe("quiet");
  });
  it.each(["binding", "session", "tree", "busy"])("fences publication when %s changes during a read", async (change) => {
    const fx = fixture(); const execute = fx.execute.getMockImplementation()!;
    fx.execute.mockImplementationOnce(async (...args) => {
      const result = await execute(...args);
      if (change === "binding") fx.binding("other");
      if (change === "session") fx.session("fork");
      if (change === "tree") fx.branch.splice(0);
      if (change === "busy") fx.busy(true);
      return result;
    });
    expect(await fx.controller.execute("team", "automatic")).toBe("skipped");
    expect(fx.send).not.toHaveBeenCalled(); expect(fx.pending()).toBeUndefined();
  });
  it("keeps a held send uncommitted and drops it on compaction gate reset", async () => {
    vi.useFakeTimers(); const fx = fixture(); fx.gate.begin();
    expect(await fx.controller.execute("team", "automatic")).toBe("published");
    expect(fx.send).not.toHaveBeenCalled(); expect(fx.pending()).toBeDefined();
    fx.gate.reset(); fx.controller.invalidate(); fx.gate.end(); await vi.runAllTimersAsync();
    expect(fx.branch).toHaveLength(1); expect(fx.pending()).toBeUndefined();
    expect(await fx.controller.execute("team", "automatic")).toBe("published");
    expect(fx.send).toHaveBeenCalledTimes(1);
  });
  it("does not retry or rewrite a persisted page after a failed provider turn", async () => {
    const fx = fixture(); await fx.controller.execute("team", "automatic");
    fx.controller.invalidate();
    expect(fx.branch).toHaveLength(2); expect(fx.send).toHaveBeenCalledTimes(1);
  });
});
