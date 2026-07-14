import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { BeadsTaskStore } from "./beads";
import * as messaging from "./messaging";
import type { Member, TaskFile } from "./models";
import * as paths from "./paths";
import * as runtime from "./runtime";
import {
  enqueueTaskChangeForRecipient,
  readTaskDeliveries,
  TaskChangeDelivery,
} from "./task-delivery";
import { migrateTeamTasks } from "./task-migration";
import { applySemanticTaskUpdate } from "./tasks";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import type { TerminalAdapter } from "./terminal-adapter";
import * as teams from "./teams";

type RegisteredTool = {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (toolCallId: string, params: any, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
};

const testTeams: string[] = [];
const testWorkspaces: string[] = [];

function teamName(suffix: string): string {
  const name = `release-p1-${suffix}-${process.pid}-${Date.now()}-${testTeams.length}`;
  testTeams.push(name);
  return name;
}

function workspace(suffix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), `pi-teams-release-p1-${suffix}-`));
  fs.mkdirSync(path.join(value, ".beads"), { recursive: true });
  fs.writeFileSync(path.join(value, ".beads", "metadata.json"), JSON.stringify({
    database: "dolt",
    backend: "dolt",
    dolt_database: `release_p1_${suffix}`,
    project_id: `release-p1-${suffix}`,
  }));
  testWorkspaces.push(value);
  return value;
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
    sessionManager: { getSessionFile: vi.fn(() => sessionFile) },
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test interleaving");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function task(id: string, owner?: string): TaskFile {
  return {
    id,
    subject: id,
    description: "contract task",
    status: "pending",
    owner,
    blocks: [],
    blockedBy: [],
    version: "v1",
  };
}

class MigrationFixture {
  tasks = new Map<string, TaskFile>();
  next = 1;
  dropMetadata = false;

  async findByLegacyId(id: string): Promise<TaskFile | undefined> {
    return [...this.tasks.values()].find((item) => item.metadata?.pi_teams_legacy_id === id);
  }

  async create(input: any): Promise<TaskFile> {
    const created: TaskFile = {
      id: `bd-${this.next++}`,
      subject: input.subject,
      description: input.description,
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: this.dropMetadata ? {} : structuredClone(input.metadata || {}),
      version: `v${this.next}`,
    };
    this.tasks.set(created.id, created);
    return structuredClone(created);
  }

  async update(id: string, updates: Partial<TaskFile>): Promise<TaskFile> {
    const current = this.tasks.get(id)!;
    const accepted = this.dropMetadata ? { ...updates, metadata: current.metadata } : updates;
    Object.assign(current, accepted, { version: `v${++this.next}` });
    return structuredClone(current);
  }

  async addDependency(id: string, blockerId: string): Promise<TaskFile> {
    const current = this.tasks.get(id)!;
    const blocker = this.tasks.get(blockerId)!;
    if (!current.blockedBy.includes(blockerId)) current.blockedBy.push(blockerId);
    if (!blocker.blocks.includes(id)) blocker.blocks.push(id);
    return structuredClone(current);
  }

  async list(): Promise<TaskFile[]> { return [...this.tasks.values()].map((item) => structuredClone(item)); }
  async read(id: string): Promise<TaskFile> { return structuredClone(this.tasks.get(id)!); }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAdapterCache();
  for (const name of testTeams.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
  for (const value of testWorkspaces.splice(0)) fs.rmSync(value, { recursive: true, force: true });
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

  it("refuses the teammate shutdown tool for the current team lead without changing membership", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("lead-shutdown");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    const before = await teams.createTeam(name, leadSession, "lead-agent");
    const tool = registerExtension().get("process_shutdown_approved")!;

    await expect(tool.execute("shutdown-lead", {
      team_name: name,
      agent_name: "team-lead",
    }, undefined, undefined, context(leadSession))).rejects.toThrow(/cannot shut down the team leader/i);

    const after = await teams.readConfig(name);
    expect(after.members.find((item) => item.membershipId === before.members[0].membershipId)).toMatchObject({
      name: "team-lead",
      isActive: true,
    });
  });

  it("refuses duplicate legacy IDs and dangling dependency targets before Beads cutover", async () => {
    const duplicateTeam = teamName("migration-duplicate");
    const duplicateWorkspace = workspace("migration-duplicate");
    await teams.createTeam(duplicateTeam, "/tmp/lead.jsonl", "lead-agent");
    fs.writeFileSync(path.join(paths.taskDir(duplicateTeam), "1.json"), JSON.stringify(task("same")));
    fs.writeFileSync(path.join(paths.taskDir(duplicateTeam), "2.json"), JSON.stringify({ ...task("same"), subject: "duplicate" }));
    await expect(migrateTeamTasks({ teamName: duplicateTeam, workspace: duplicateWorkspace, beads: new MigrationFixture() as any }))
      .rejects.toThrow(/duplicate legacy Task IDs/i);
    expect((await teams.readConfig(duplicateTeam)).taskBackend).toBeUndefined();

    const danglingTeam = teamName("migration-dangling");
    const danglingWorkspace = workspace("migration-dangling");
    await teams.createTeam(danglingTeam, "/tmp/lead.jsonl", "lead-agent");
    fs.writeFileSync(path.join(paths.taskDir(danglingTeam), "1.json"), JSON.stringify({
      ...task("1"),
      blockedBy: ["missing"],
    }));
    await expect(migrateTeamTasks({ teamName: danglingTeam, workspace: danglingWorkspace, beads: new MigrationFixture() as any }))
      .rejects.toThrow(/dependencies reference missing targets/i);
    expect((await teams.readConfig(danglingTeam)).taskBackend).toBeUndefined();
  });

  it("treats metadata drift as a reconciliation mismatch and refuses cutover", async () => {
    const name = teamName("migration-metadata");
    const beadsWorkspace = workspace("migration-metadata");
    await teams.createTeam(name, "/tmp/lead.jsonl", "lead-agent");
    fs.writeFileSync(path.join(paths.taskDir(name), "1.json"), JSON.stringify({
      ...task("1"),
      metadata: { source: "legacy", nested: { retained: true } },
    }));
    const fixture = new MigrationFixture();
    fixture.dropMetadata = true;

    const report = await migrateTeamTasks({ teamName: name, workspace: beadsWorkspace, beads: fixture as any });

    expect(report.cutover).toBe(false);
    expect(report.mismatches).toContainEqual(expect.objectContaining({ legacyId: "1", field: "metadata" }));
    expect(report.errors.join(" ")).toMatch(/reconciliation failed/i);
    expect((await teams.readConfig(name)).taskBackend).toBeUndefined();
  });

  it("attempts every teammate shutdown and leaves a kill failure current instead of claiming closure", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const killed: string[] = [];
    const adapter: TerminalAdapter = {
      name: "contract-terminal",
      detect: () => true,
      spawn: () => "unused",
      kill: (paneId) => {
        killed.push(paneId);
        if (paneId === "pane-fails") throw new Error("simulated terminal kill failure");
      },
      isAlive: (paneId) => paneId === "pane-fails",
      setTitle() {},
      supportsWindows: () => false,
      spawnWindow: () => "unused",
      setWindowTitle() {},
      killWindow() {},
      isWindowAlive: () => true,
    };
    setAdapter(adapter);
    const name = teamName("partial-shutdown");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    await teams.createTeam(name, leadSession, "lead-agent");
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
    expect(result.details.failures).toEqual([
      expect.objectContaining({ name: "fails", error: expect.stringContaining("simulated terminal kill failure") }),
    ]);
    expect(result.details.stopEvidence).toEqual([
      expect.objectContaining({ kind: "terminal_pane_stopped", target: "pane-succeeds" }),
    ]);
  });

  it.each([
    ["Windows Terminal", "windows_123_worker"],
    ["Zellij", "zellij_worker"],
  ])("fails closed when %s cannot stop its synthetic pane", async (adapterName, paneId) => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const adapter: TerminalAdapter = {
      name: adapterName,
      detect: () => true,
      spawn: () => "unused",
      kill() {},
      isAlive: () => true,
      setTitle() {},
      supportsWindows: () => adapterName === "Windows Terminal",
      spawnWindow: () => "unused",
      setWindowTitle() {},
      killWindow() {},
      isWindowAlive: () => true,
    };
    setAdapter(adapter);
    const name = teamName(`unsupported-stop-${adapterName.replace(/[^a-z0-9]+/gi, "-")}`);
    const leadSession = `/tmp/${name}-lead.jsonl`;
    await teams.createTeam(name, leadSession, "lead-agent");
    const worker = member("worker", `/tmp/${name}-worker.jsonl`, { tmuxPaneId: paneId });
    await teams.addMember(name, worker);
    await runtime.writeRuntimeStatus(name, "worker", {
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    }, worker.membershipId);
    const tool = registerExtension().get("process_shutdown_approved")!;

    await expect(tool.execute("shutdown", {
      team_name: name,
      agent_name: "worker",
    }, undefined, undefined, context(leadSession))).rejects.toThrow(/cannot confirm shutdown.*remains current/i);

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
    await teams.createTeam(name, leadSession, "lead-agent");
    const worker = member("worker", `/tmp/${name}-worker.jsonl`, { tmuxPaneId: "zellij_worker" });
    await teams.addMember(name, worker);
    await runtime.writeRuntimeStatus(name, "worker", { pid: 2_147_483_647, startedAt: Date.now() }, worker.membershipId);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 2_147_483_647 && signal === 0) {
        const error = new Error("gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill);
    const tool = registerExtension().get("process_shutdown_approved")!;

    const result = await tool.execute("shutdown", {
      team_name: name,
      agent_name: "worker",
    }, undefined, undefined, context(leadSession));

    expect(result.details.stopEvidence).toMatchObject({
      kind: "bound_process_already_exited",
      membershipId: worker.membershipId,
    });
    expect((await teams.readConfig(name)).members.find((item) => item.membershipId === worker.membershipId)?.isActive).toBe(false);
  });

  it("does not deactivate a Membership when its runtime process generation changes after exit evidence", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    const name = teamName("manual-exit-generation-race");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    await teams.createTeam(name, leadSession, "lead-agent");
    const worker = member("worker", `/tmp/${name}-worker.jsonl`);
    await teams.addMember(name, worker);
    const oldPid = 2_147_483_647;
    const newPid = 2_147_483_646;
    await runtime.writeRuntimeStatus(name, "worker", { pid: oldPid, startedAt: 1 }, worker.membershipId);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === oldPid && signal === 0) {
        fs.writeFileSync(paths.runtimeStatusPath(name, "worker"), JSON.stringify({
          teamName: name,
          agentName: "worker",
          membershipId: worker.membershipId,
          pid: newPid,
          startedAt: 2,
        }));
        const error = new Error("old process exited") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill);
    const tool = registerExtension().get("process_shutdown_approved")!;

    await expect(tool.execute("shutdown", {
      team_name: name,
      agent_name: "worker",
    }, undefined, undefined, context(leadSession))).rejects.toThrow(/runtime process generation changed.*remains current/i);

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
    expect(await runtime.readRuntimeStatus(name, "worker")).toBeNull();

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
    const adapter: TerminalAdapter = {
      name: "Zellij",
      detect: () => true,
      spawn: () => "unused",
      kill() {},
      isAlive: () => true,
      setTitle() {},
      supportsWindows: () => false,
      spawnWindow: () => "unused",
      setWindowTitle() {},
      killWindow() {},
      isWindowAlive: () => true,
    };
    setAdapter(adapter);
    const name = teamName("wrong-generation-runtime");
    const leadSession = `/tmp/${name}-lead.jsonl`;
    await teams.createTeam(name, leadSession, "lead-agent");
    const worker = member("worker", `/tmp/${name}-worker.jsonl`, { tmuxPaneId: "zellij_worker" });
    await teams.addMember(name, worker);
    await runtime.writeRuntimeStatus(name, "worker", { pid: 2_147_483_647, startedAt: Date.now() }, "membership-from-an-older-generation");
    const killProbe = vi.spyOn(process, "kill");
    const tool = registerExtension().get("process_shutdown_approved")!;

    await expect(tool.execute("shutdown", {
      team_name: name,
      agent_name: "worker",
    }, undefined, undefined, context(leadSession))).rejects.toThrow(/cannot confirm shutdown.*remains current/i);

    expect(killProbe).not.toHaveBeenCalled();
    expect((await teams.readConfig(name)).members.find((item) => item.membershipId === worker.membershipId)?.isActive).toBe(true);
  });

  it("never lets a replaced Membership or Session consume an older Task delivery", async () => {
    const name = teamName("task-delivery-generation");
    const oldSession = `/tmp/${name}-old.jsonl`;
    const newSession = `/tmp/${name}-new.jsonl`;
    await teams.createTeam(name, `/tmp/${name}-lead.jsonl`, "lead-agent", undefined, undefined, undefined, workspace("delivery"), "task-authority-contract", {
      schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: "release_p1_delivery", projectId: "release-p1-delivery",
    });
    const oldMember = member("worker", oldSession);
    await teams.addMember(name, oldMember);
    const record = await enqueueTaskChangeForRecipient(name, task("task-1", "worker"), "worker", "assigned");
    expect(record?.recipientMembershipId).toBe(oldMember.membershipId);

    await teams.deactivateMember(name, "worker", "replaced");
    const replacement = member("worker", newSession);
    await teams.addMember(name, replacement);
    const staleSend = vi.fn();
    const stale = new TaskChangeDelivery({ sendMessage: staleSend, appendEntry: vi.fn() }, {
      teamName: name,
      recipient: "worker",
      membershipId: oldMember.membershipId,
      sessionFile: oldSession,
      pollMs: 60_000,
      reconcile: async () => 0,
    });

    await stale.start([]);
    await stale.scan();
    stale.stop();

    expect(staleSend).not.toHaveBeenCalled();
    const remaining = await readTaskDeliveries(name, "worker");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      recipientMembershipId: oldMember.membershipId,
      recipientSessionFile: oldSession,
    });
    expect(remaining[0].successfulTurnAckAt).toBeUndefined();
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
    });
    await waitFor(() => fs.existsSync(`${paths.configPath(name)}.lock`));
    let replacementFinished = false;
    const replacement = (async () => {
      await teams.withCurrentMembershipLease(name, oldMember.membershipId!, async () => {
        await teams.deactivateMembership(name, oldMember.membershipId!, "replaced");
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
    })).rejects.toThrow(/refusing a stale Message append/i);
    expect(await messaging.readInbox(name, "peer", false, false)).toHaveLength(countAfterSerializedCommit);
  });

  it("serializes Task replacement against authority mutation and rejects the stale writer afterward", async () => {
    const name = teamName("task-race");
    const oldSession = `/tmp/${name}-old.jsonl`;
    await teams.createTeam(name, `/tmp/${name}-lead.jsonl`, "lead-agent", undefined, undefined, undefined, workspace("task-race"), "task-authority-race", {
      schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: "release_p1_task-race", projectId: "release-p1-task-race",
    });
    const oldMember = member("worker", oldSession);
    await teams.addMember(name, oldMember);
    const before = task("task-race");
    let enterMutation!: () => void;
    let releaseMutation!: () => void;
    const entered = new Promise<void>((resolve) => { enterMutation = resolve; });
    const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const update = vi.spyOn(BeadsTaskStore.prototype, "updateWithResult").mockImplementation(async () => {
      enterMutation();
      await release;
      return {
        before,
        after: { ...before, status: "in_progress", version: "v2" },
        appliedOperations: ["set:status"],
      };
    });

    const mutation = applySemanticTaskUpdate(name, before.id, { status: "in_progress" }, {
      actor: "worker",
      actingMembershipId: oldMember.membershipId,
      actingSessionFile: oldSession,
    });
    await entered;
    let replacementFinished = false;
    const replacement = (async () => {
      await teams.withCurrentMembershipLease(name, oldMember.membershipId!, async () => {
        await teams.deactivateMembership(name, oldMember.membershipId!, "replaced");
      });
      await teams.addMember(name, member("worker", `/tmp/${name}-new.jsonl`));
      replacementFinished = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(replacementFinished).toBe(false);

    releaseMutation();
    await expect(mutation).resolves.toMatchObject({ task: { status: "in_progress", version: "v2" } });
    await replacement;
    const callsBeforeStaleAttempt = update.mock.calls.length;

    await expect(applySemanticTaskUpdate(name, before.id, { status: "in_progress" }, {
      actor: "worker",
      actingMembershipId: oldMember.membershipId,
      actingSessionFile: oldSession,
    })).rejects.toThrow(/stale processes cannot mutate authority state/i);
    expect(update).toHaveBeenCalledTimes(callsBeforeStaleAttempt);
  });

  it("does not publish the removed task_update.blocks input", () => {
    const schema = registerExtension().get("task_update")!.parameters;
    expect(schema.properties).toHaveProperty("blocked_by");
    expect(schema.properties).not.toHaveProperty("blocks");
  });
});
