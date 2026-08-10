import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  config: { name: "team", terminalBackend: "fake", members: [] as any[] },
  guard: [] as string[],
  events: [] as string[],
  runtime: null as any,
  deleteRuntime: vi.fn(async () => true),
  kill: vi.fn(),
  killWindow: vi.fn(),
  paneAlive: false,
  windowAlive: false,
  stopped: [] as string[],
  deactivate: [] as string[],
}));

vi.mock("../utils/paths", () => ({ sanitizeName: (name: string) => name }));
vi.mock("../utils/teams", () => ({
  withTeamTopologyLease: async (_team: string, action: () => Promise<unknown>) => {
    fixture.events.push("topology");
    return action();
  },
  readConfig: async () => fixture.config,
  withCurrentMembershipLease: async (_team: string, membershipId: string, action: (member: any) => Promise<unknown>) => {
    fixture.events.push(`membership:${membershipId}`);
    const member = fixture.config.members.find((candidate: any) => candidate.membershipId === membershipId && candidate.isActive !== false);
    if (!member) throw new Error("current Membership changed");
    return action(member);
  },
  deactivateMembership: async (_team: string, membershipId: string, reason: string) => {
    fixture.events.push(`deactivate:${membershipId}`);
    const member = fixture.config.members.find((candidate: any) => candidate.membershipId === membershipId && candidate.isActive !== false);
    if (!member) return null;
    member.isActive = false;
    member.deactivationReason = reason;
    fixture.deactivate.push(member.name);
    return member;
  },
}));
vi.mock("../utils/runtime", () => ({
  readRuntimeStatus: async () => fixture.runtime,
  runtimeGeneration: (status: any) => status?.generation ?? null,
  deleteRuntimeStatus: fixture.deleteRuntime,
}));
vi.mock("../utils/terminal-target", () => ({
  assertTeamTerminalTarget: (_config: unknown, member: any) => member.terminalTarget,
  memberTerminalTarget: (member: any) => member.terminalTarget,
}));
vi.mock("../utils/team-terminal", () => ({
  terminalForTeam: () => ({
    name: "fake-terminal",
    kill: (...args: unknown[]) => fixture.kill(...args),
    killWindow: (...args: unknown[]) => fixture.killWindow(...args),
    isAlive: () => fixture.paneAlive,
    isWindowAlive: () => fixture.windowAlive,
  }),
  assertTargetSupportedByTerminal: () => undefined,
}));

import { TeamLifecycleService } from "./team-lifecycle-service";
import type { AssignedWorkGuard } from "./assigned-work-guard";
import type { TeamLifecyclePublication } from "./team-lifecycle-publication";

function member(name: string, target: { kind: "pane" | "window"; targetId: string } = { kind: "pane", targetId: `${name}-pane` }) {
  return { name, agentType: name === "team-lead" ? "lead" : "teammate", isActive: true, membershipId: `${name}-membership`, terminalTarget: { backend: "fake", ...target } };
}

function publication(stoppedFailure?: Error): TeamLifecyclePublication {
  return {
    readEventCursor: () => "0",
    recordWorkerPrepared: async () => ({ cursor: "0" }),
    recordWorkerStopped: async ({ workerName }) => {
      fixture.events.push(`stopped:${workerName}`);
      if (stoppedFailure) throw stoppedFailure;
      fixture.stopped.push(workerName);
      return { cursor: "0" };
    },
    recordWorkerSessionBound: async () => ({ cursor: "0" }),
    recordWorkerFailed: async () => ({ cursor: "0" }),
    observeWorkerStartup: async () => ({ observed: false, carrier: "prepared", runtime: "not_observed", cursor: "0", reason: "timeout" }),
  };
}

function guard(): AssignedWorkGuard {
  return { nonterminalTaskIds: vi.fn(async (_team: string, worker?: string) => {
    fixture.events.push(`guard:${worker ?? "all"}`);
    return fixture.guard;
  }) };
}

function reset() {
  fixture.config = { name: "team", terminalBackend: "fake", members: [] };
  fixture.guard = [];
  fixture.events = [];
  fixture.runtime = null;
  fixture.deleteRuntime.mockReset().mockResolvedValue(true);
  fixture.kill.mockReset();
  fixture.killWindow.mockReset();
  fixture.paneAlive = false;
  fixture.windowAlive = false;
  fixture.stopped = [];
  fixture.deactivate = [];
}

describe("Team lifecycle service boundary", () => {
  it("queries the injected guard inside topology lock and before a Membership lease", async () => {
    reset();
    fixture.config.members = [member("worker")];
    fixture.guard = ["task-1"];
    const assignedWorkGuard = guard();
    const service = new TeamLifecycleService({ assignedWorkGuard, lifecyclePublication: publication() });

    await expect(service.stopWorker("team", "worker")).resolves.toMatchObject({ kind: "refused", reason: "nonterminal_tasks_assigned", guardingTaskIds: ["task-1"] });
    expect(fixture.events).toEqual(["topology", "guard:worker"]);
    expect(assignedWorkGuard.nonterminalTaskIds).toHaveBeenCalledWith("team", "worker");
  });

  it("does not accept exited runtime evidence when its exact Membership generation changed", async () => {
    reset();
    const worker = member("worker");
    delete (worker as { terminalTarget?: unknown }).terminalTarget;
    fixture.config.members = [worker];
    fixture.runtime = { generation: { membershipId: "replacement-membership", pid: 12345 } };
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { const error = new Error("gone") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; });
    const service = new TeamLifecycleService({ assignedWorkGuard: guard(), lifecyclePublication: publication() });

    await expect(service.stopWorker("team", "worker")).resolves.toMatchObject({ kind: "refused", reason: "stop_not_confirmed" });
    expect(fixture.deleteRuntime).not.toHaveBeenCalled();
    expect(worker.isActive).toBe(true);
    kill.mockRestore();
  });

  it.each([
    ["pane", "pane-1", "kill"],
    ["window", "window-1", "killWindow"],
  ] as const)("confirms a stopped %s before deactivation", async (kind, targetId, killMethod) => {
    reset();
    fixture.config.members = [member("worker", { kind, targetId })];
    const service = new TeamLifecycleService({ assignedWorkGuard: guard(), lifecyclePublication: publication() });

    await expect(service.stopWorker("team", "worker")).resolves.toEqual({ kind: "stopped", worker: "worker" });
    expect(killMethod === "kill" ? fixture.kill : fixture.killWindow).toHaveBeenCalledWith(targetId);
    expect(fixture.deactivate).toEqual(["worker"]);
    expect(fixture.events).toEqual(["topology", "guard:worker", "membership:worker-membership", "deactivate:worker-membership", "stopped:worker"]);
  });

  it("characterizes a stopped-event publication failure after the Membership deactivates", async () => {
    reset();
    const worker = member("worker");
    fixture.config.members = [worker];
    const assignedWorkGuard = guard();
    const service = new TeamLifecycleService({
      assignedWorkGuard,
      lifecyclePublication: publication(new Error("stopped-event append failed")),
    });

    await expect(service.stopWorker("team", "worker")).resolves.toEqual({
      kind: "refused",
      worker: "worker",
      reason: "stop_not_confirmed",
      message: "stopped-event append failed",
    });
    expect(worker).toMatchObject({ isActive: false, deactivationReason: "process_shutdown" });
    expect(fixture.events).toEqual(["topology", "guard:worker", "membership:worker-membership", "deactivate:worker-membership", "stopped:worker"]);
    expect(assignedWorkGuard.nonterminalTaskIds).toHaveBeenCalledTimes(1);
    expect(fixture.guard).toEqual([]);
    expect(fixture.kill).toHaveBeenCalledTimes(1);

    await expect(service.stopWorker("team", "worker")).resolves.toEqual({
      kind: "refused",
      worker: "worker",
      reason: "worker_not_found",
      message: "Worker worker is not current.",
    });
    expect(fixture.kill).toHaveBeenCalledTimes(1);
    expect(assignedWorkGuard.nonterminalTaskIds).toHaveBeenCalledTimes(1);
  });

  it("retains the current Membership when pane stop confirmation fails", async () => {
    reset();
    const worker = member("worker");
    fixture.config.members = [worker];
    fixture.paneAlive = true;
    const service = new TeamLifecycleService({ assignedWorkGuard: guard(), lifecyclePublication: publication() });

    await expect(service.stopWorker("team", "worker")).resolves.toMatchObject({ kind: "refused", reason: "stop_not_confirmed" });
    expect(fixture.kill).toHaveBeenCalledWith("worker-pane");
    expect(worker.isActive).toBe(true);
    expect(fixture.deactivate).toEqual([]);
    expect(fixture.stopped).toEqual([]);
  });

  it("sorts parallel shutdown partial results and keeps the lead current until every teammate stops", async () => {
    reset();
    const lead = member("team-lead");
    const alpha = member("alpha");
    const zulu = member("zulu");
    const bravo = member("bravo");
    fixture.config.members = [lead, zulu, alpha, bravo];
    fixture.kill.mockImplementation((targetId: string) => { if (targetId === "zulu-pane" || targetId === "bravo-pane") throw new Error(`cannot stop ${targetId}`); });
    const service = new TeamLifecycleService({ assignedWorkGuard: guard(), lifecyclePublication: publication() });

    await expect(service.shutdownTeam("team")).resolves.toEqual({ kind: "partial", stoppedWorkers: ["alpha"], failedWorkers: ["bravo", "zulu"], unfinishedTaskIds: [] });
    expect(alpha.isActive).toBe(false);
    expect(bravo.isActive).toBe(true);
    expect(zulu.isActive).toBe(true);
    expect(lead.isActive).toBe(true);
    expect(fixture.deactivate).toEqual(["alpha"]);
    expect(fixture.events.at(-1)).toBe("guard:all");
  });

  it("does not expose concrete Task or adapter imports from Team authority", () => {
    const root = path.join(__dirname, "team-lifecycle-service.ts");
    const source = fs.readFileSync(root, "utf8");
    const adapter = fs.readFileSync(path.join(__dirname, "../adapters/durable-assigned-work-guard.ts"), "utf8");
    expect(source).not.toMatch(/utils\/tasks|model-tool-contract|team-events|extensions\/|\.\.\/adapters/);
    expect(source).toContain("assignedWorkGuard: AssignedWorkGuard");
    expect(source).toContain("lifecyclePublication: TeamLifecyclePublication");
    expect(adapter).not.toMatch(/utils\/tasks/);
    expect(adapter).toContain('import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter"');
    expect(adapter).toContain('import type { AssignedWorkGuard } from "../team-authority/assigned-work-guard"');
  });
});
