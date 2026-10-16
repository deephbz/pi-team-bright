import { mockGenerations } from "../../test/process-fixture";
import { terminalFixture } from "../../test/terminal-fixture";
import fs from "node:fs";
import { nodeHostEnv } from "../env/host-env";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { DurableAlertMembership } from "../adapters/durable-alert-membership";
import * as messaging from "../alert-authority/inbox-delivery";
import type { Member } from "../team-authority/contracts";
import * as paths from "./paths";
import * as runtime from "./runtime";
import { clearAdapterCache, getTerminalAdapter, setAdapter } from "../adapters/terminal-registry";
import type { TerminalAdapter } from "./terminal-adapter";
import * as teams from "./teams";

const alertMembership = new DurableAlertMembership();

type RegisteredTool = {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (toolCallId: string, params: any, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
};

const testTeams: string[] = [];

function teamName(suffix: string): string {
  const name = `release-p1-${suffix}-${process.pid}-${Date.now()}-${testTeams.length}`;
  testTeams.push(name);
  return name;
}


function member(name: string, sessionFile: string, extra: Partial<Member> = {}): Member {
  return {
    membershipId: teams.newMembershipId(),
    agentId: `${name}@contract`,
    name,
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
    ...extra,
  };
}

function context(sessionFile: string) {
  return {
    isIdle: vi.fn(() => false),
    sessionManager: { getSessionFile: vi.fn(() => sessionFile), getBranch: () => [] },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  };
}

function registerExtension(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  piTeams({
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    on() {},
    sendUserMessage() {},
  } as never);
  return tools;
}

function registerSessionExtension(): Map<string, (...args: any[]) => any> {
  const handlers = new Map<string, (...args: any[]) => any>();
  piTeams({
    registerTool() {},
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
    sendUserMessage() {},
  } as never);
  return handlers;
}

async function createBeadsTeam(name: string, leadSession: string) {
  return teams.createTeam(name, leadSession, "lead-agent", undefined, undefined, undefined, undefined, await terminalBinding());
}

/**
 * Mirror team_create: a Team binds the detected terminal backend at creation,
 * so lifecycle operations resolve it from durable authority instead of ambient
 * detection. Members keep legacy pane IDs to retain legacy-read coverage.
 */
async function terminalBinding(): Promise<teams.TeamTerminalBinding | undefined> {
  const detected = await getTerminalAdapter();
  return detected ? { backend: detected.name } : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test interleaving");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAdapterCache();
  for (const name of testTeams.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
});

describe("release P1 public contracts", () => {
  it("reserves team-lead and rejects a second current member with the same name", async () => {
    const name = teamName("unique-roster");
    await teams.createTeam(name, `/tmp/${name}-lead.jsonl`, "lead-agent");

    await expect(teams.addMember(name, member("team-lead", `/tmp/${name}-impostor.jsonl`)))
      .rejects.toThrow(/team-lead.*reserved/i);

    await teams.addMember(name, member("worker", `/tmp/${name}-worker-a.jsonl`));
    await expect(teams.addMember(name, member("worker", `/tmp/${name}-worker-b.jsonl`)))
      .rejects.toThrow(/current member named worker already exists/i);
    expect((await teams.readConfig(name)).members.filter((item) => item.name === "worker" && item.isActive !== false)).toHaveLength(1);
  });

  it("refuses worker_stop for the current team lead without changing membership", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("lead-shutdown");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    const before = await teams.createTeam(name, leadSession, "lead-agent");
    const tool = registerExtension().get("worker_stop")!;

    await expect(tool.execute("shutdown-lead", {
      team_name: name,
      worker: "team-lead",
    }, undefined, undefined, context(leadSession))).resolves.toMatchObject({ details: { kind: "refused", reason: "leader_reserved", state_changed: false } });

    const after = await teams.readConfig(name);
    expect(after.members.find((item) => item.membershipId === before.members[0].membershipId)).toMatchObject({
      name: "team-lead",
      isActive: true,
    });
  });

  it("attempts every Worker stop and leaves a kill failure current instead of claiming closure", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const killed: string[] = [];
    const adapter = terminalFixture({ name: "contract-terminal",
      kill: async paneId => {
        killed.push(paneId);
        if (paneId === "pane-fails") throw new Error("simulated terminal kill failure");
      },
      isAlive: async paneId => paneId === "pane-fails", isWindowAlive: async () => true,
    });
    setAdapter(adapter);
    const name = teamName("partial-shutdown");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    await createBeadsTeam(name, leadSession);
    await teams.addMember(name, member("fails", `/tmp/${name}-fails.jsonl`, { tmuxPaneId: "pane-fails" }));
    await teams.addMember(name, member("succeeds", `/tmp/${name}-succeeds.jsonl`, { tmuxPaneId: "pane-succeeds" }));
    const tool = registerExtension().get("team_shutdown")!;

    const result = await tool.execute("shutdown", { team_name: name }, undefined, undefined, context(leadSession));

    expect(killed).toEqual(["pane-fails", "pane-succeeds"]);
    const config = await teams.readConfig(name);
    expect(config.members.find((item) => item.name === "fails")?.isActive).toBe(true);
    expect(config.members.find((item) => item.name === "succeeds")?.isActive).toBe(false);
    expect(config.members.find((item) => item.name === "team-lead")?.isActive).not.toBe(false);
    expect(config.members.find((item) => item.name === "team-lead")?.isActive).toBe(true);
    expect(result.details).toMatchObject({ kind: "partial", lifecycle: "active", failed_workers: ["fails"], state_changed: true });
  });

  it.each([
    ["Windows Terminal", "windows_123_worker"],
    ["Zellij", "zellij_worker"],
  ])("fails closed when %s cannot stop its synthetic pane", async (adapterName, paneId) => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const adapter = terminalFixture({ name: adapterName, isAlive: async () => true,
      supportsWindows: () => adapterName === "Windows Terminal", isWindowAlive: async () => true });
    setAdapter(adapter);
    const name = teamName(`unsupported-stop-${adapterName.replace(/[^a-z0-9]+/gi, "-")}`);
    const leadSession = `/tmp/${name}-lead.jsonl`;
    await createBeadsTeam(name, leadSession);
    const worker = member("worker", `/tmp/${name}-worker.jsonl`, { tmuxPaneId: paneId });
    await teams.addMember(name, worker);
    await runtime.writeRuntimeStatus(name, "worker", {
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    }, worker.membershipId);
    const tool = registerExtension().get("worker_stop")!;

    await expect(tool.execute("shutdown", {
      team_name: name,
      worker: "worker",
    }, undefined, undefined, context(leadSession))).resolves.toMatchObject({ details: { kind: "refused", reason: "stop_not_confirmed", state_changed: false } });

    expect((await teams.readConfig(name)).members.find((item) => item.membershipId === worker.membershipId)?.isActive).toBe(true);
    expect(await runtime.readRuntimeStatus(name, "worker")).toMatchObject({
      membershipId: worker.membershipId,
      pid: process.pid,
    });
  });

  it("can finalize a manually stopped process only from exact Membership-bound runtime evidence", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("already-exited");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    await createBeadsTeam(name, leadSession);
    const worker = member("worker", `/tmp/${name}-worker.jsonl`, { tmuxPaneId: "zellij_worker" });
    await teams.addMember(name, worker);
    await runtime.writeRuntimeStatus(name, "worker", {
      pid: 2_147_483_647, startedAt: Date.now(),
      osBirthToken: "synthetic-stopped-generation", bootId: "synthetic-boot",
    }, worker.membershipId);
    const generations = nodeHostEnv.process.generations;
    vi.spyOn(nodeHostEnv.process, "generations").mockImplementation(async pids => {
      const results = await generations(pids);
      if (pids.includes(2_147_483_647)) results.set(2_147_483_647, { kind: "absent" });
      return results;
    });
    const tool = registerExtension().get("worker_stop")!;

    const result = await tool.execute("shutdown", {
      team_name: name,
      worker: "worker",
    }, undefined, undefined, context(leadSession));

    expect(result.details).toMatchObject({ kind: "worker_stopped", worker: "worker", state_changed: true });
    expect((await teams.readConfig(name)).members.find((item) => item.membershipId === worker.membershipId)?.isActive).toBe(false);
  });

  it("does not deactivate a Membership when its runtime process generation changes after exit evidence", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("manual-exit-generation-race");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    await createBeadsTeam(name, leadSession);
    const worker = member("worker", `/tmp/${name}-worker.jsonl`);
    await teams.addMember(name, worker);
    const oldPid = 2_147_483_647;
    const newPid = 2_147_483_646;
    await runtime.writeRuntimeStatus(name, "worker", { pid: oldPid, startedAt: 1, osBirthToken: "old-birth", bootId: "fixture-boot" }, worker.membershipId);
    mockGenerations(pid => {
      if (pid === oldPid) {
        fs.writeFileSync(paths.runtimeStatusPath(name, "worker"), JSON.stringify({
          teamName: name,
          agentName: "worker",
          membershipId: worker.membershipId,
          pid: newPid,
          startedAt: 2,
          osBirthToken: "new-birth",
          bootId: "fixture-boot",
        }));
        return { kind: "absent" };
      }
      return { kind: "found", generation: { pid, osBirthToken: "new-birth", bootId: "fixture-boot" } };
    });
    const tool = registerExtension().get("worker_stop")!;

    await expect(tool.execute("shutdown", {
      team_name: name,
      worker: "worker",
    }, undefined, undefined, context(leadSession))).resolves.toMatchObject({ details: { kind: "refused", reason: "stop_not_confirmed", state_changed: false } });

    expect((await teams.readConfig(name)).members.find((item) => item.membershipId === worker.membershipId)?.isActive).toBe(true);
    expect(await runtime.readRuntimeStatus(name, "worker")).toMatchObject({
      membershipId: worker.membershipId,
      pid: newPid,
      startedAt: 2,
    });
  });

  it("serializes teammate resume publication behind the exact Membership mutation lease", async () => {
    vi.stubEnv("PI_AGENT_NAME", "worker");
    const name = teamName("resume-shutdown-lease");
    vi.stubEnv("PI_TEAM_NAME", name);
    const leadSession = `/tmp/${name}-lead.jsonl`;
    const workerSession = `/tmp/${name}-worker.jsonl`;
    await teams.createTeam(name, leadSession, "lead-agent");
    const worker = member("worker", workerSession);
    await teams.addMember(name, worker);
    await runtime.writeRuntimeStatus(name, "worker", { pid: 2_147_483_647, startedAt: 1, osBirthToken: "old-birth", bootId: "fixture-boot" }, worker.membershipId);
    const generations = nodeHostEnv.process.generations;
    vi.spyOn(nodeHostEnv.process, "generations").mockImplementation(async pids => {
      const results = await generations(pids);
      if (pids.includes(2_147_483_647)) results.set(2_147_483_647, { kind: "absent" });
      return results;
    });
    const handlers = registerSessionExtension();

    let releaseLease!: () => void;
    const holdLease = new Promise<void>((resolve) => { releaseLease = resolve; });
    let leaseEntered!: () => void;
    const didEnterLease = new Promise<void>((resolve) => { leaseEntered = resolve; });
    const holder = teams.withMembershipMutationLease(name, worker.membershipId!, async () => {
      leaseEntered();
      await holdLease;
    });
    await didEnterLease;

    let startupSettled = false;
    const startup = handlers.get("session_start")!({ reason: "resume" }, context(workerSession))
      .finally(() => { startupSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(startupSettled).toBe(false);
    expect(await runtime.readRuntimeStatus(name, "worker")).toMatchObject({
      membershipId: worker.membershipId,
      pid: 2_147_483_647,
      startedAt: 1,
    });

    releaseLease();
    await holder;
    await startup;
    expect(await runtime.readRuntimeStatus(name, "worker")).toMatchObject({
      membershipId: worker.membershipId,
      pid: process.pid,
      ready: false,
    });
    await handlers.get("session_shutdown")?.({ reason: "quit" }, context(workerSession));
  });

  it("rejects an exited PID record owned by a different Membership generation", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const adapter = terminalFixture({ name: "Zellij", isAlive: async () => true, isWindowAlive: async () => true });
    setAdapter(adapter);
    const name = teamName("wrong-generation-runtime");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    await createBeadsTeam(name, leadSession);
    const worker = member("worker", `/tmp/${name}-worker.jsonl`, { tmuxPaneId: "zellij_worker" });
    await teams.addMember(name, worker);
    await runtime.writeRuntimeStatus(name, "worker", { pid: 2_147_483_647, startedAt: Date.now() }, "membership-from-an-older-generation");
    const killProbe = vi.spyOn(process, "kill");
    const tool = registerExtension().get("worker_stop")!;

    await expect(tool.execute("shutdown", {
      team_name: name,
      worker: "worker",
    }, undefined, undefined, context(leadSession))).resolves.toMatchObject({ details: { kind: "refused", reason: "stop_not_confirmed", state_changed: false } });

    expect(killProbe).not.toHaveBeenCalled();
    expect((await teams.readConfig(name)).members.find((item) => item.membershipId === worker.membershipId)?.isActive).toBe(true);
  });

  it("serializes Message replacement against append and rejects the stale writer afterward", async () => {
    const name = teamName("message-race");
    await teams.createTeam(name, `/tmp/${name}-lead.jsonl`, "lead-agent");
    const oldSession = `/tmp/${name}-old.jsonl`;
    const oldMember = member("worker", oldSession);
    await teams.addMember(name, oldMember);
    await teams.addMember(name, member("peer", `/tmp/${name}-peer.jsonl`));

    const inbox = paths.inboxPath(name, "peer");
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    fs.writeFileSync(`${inbox}.lock`, "contract-test", { flag: "wx" });

    const send = messaging.sendPlainMessage(name, "worker", "peer", "before replacement", "race", undefined, {
      membershipId: oldMember.membershipId!,
      sessionFile: oldSession,
    }, alertMembership);
    await waitFor(() => fs.existsSync(`${paths.configPath(name)}.lock`));
    let replacementFinished = false;
    const replacement = (async () => {
      await teams.withCurrentMembershipLease(name, oldMember.membershipId!, async () => {
        await teams.deactivateMembership(name, oldMember.membershipId!, "replaced", { authority: "process_stopped", carrier: "two_stage" });
      });
      await teams.addMember(name, member("worker", `/tmp/${name}-new.jsonl`));
      replacementFinished = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(replacementFinished).toBe(false);

    fs.unlinkSync(`${inbox}.lock`);
    await expect(send).resolves.toMatchObject({ text: "before replacement" });
    await replacement;
    const countAfterSerializedCommit = (await messaging.readInbox(name, "peer", false, false)).length;

    await expect(messaging.sendPlainMessage(name, "worker", "peer", "stale", "must reject", undefined, {
      membershipId: oldMember.membershipId!,
      sessionFile: oldSession,
    }, alertMembership)).rejects.toThrow(/refusing a stale Message append/i);
    expect(await messaging.readInbox(name, "peer", false, false)).toHaveLength(countAfterSerializedCommit);
  });

  it("keeps graph edits in atomic task_graph_apply and out of task_update", () => {
    const tools = registerExtension();
    const createSchema = tools.get("task_graph_apply")!.parameters;
    const updateSchema = tools.get("task_update")!.parameters;
    expect(createSchema.properties).toHaveProperty("tasks");
    expect((createSchema as any).properties.tasks.items.properties).toHaveProperty("needs");
    expect(createSchema.properties).not.toHaveProperty("dependencies");
    expect(updateSchema.properties).not.toHaveProperty("blocked_by");
    expect(updateSchema.properties).not.toHaveProperty("blocks");
    expect(tools.has("task_link")).toBe(false);
  });
});
