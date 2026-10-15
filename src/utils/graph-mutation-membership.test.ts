import { writeJsonFixture } from "./test-write-json";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { UNSUPPORTED_BEADS_TEAM } from "../task-authority/graph-authority-errors";
import { TeamLifecycleService } from "../team-authority/team-lifecycle-service";
import { DurableTeamLifecyclePublication } from "../adapters/durable-team-lifecycle-publication";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import * as teams from "./teams";
import * as paths from "./paths";
import * as runtime from "./runtime";

const names: string[] = [];
async function fixture() {
  const name = `graph-binding-${process.pid}-${names.length}`; names.push(name);
  const leadSession = `/synthetic/${name}-lead`, workerSession = `/synthetic/${name}-worker`;
  await teams.createTeam(name, leadSession, "lead");
  await teams.ensureLogicalWorker(name, { name: "worker", scope: "Complete work." });
  await teams.addMember(name, { membershipId: "old-worker", agentId: "worker", name: "worker", agentType: "teammate", joinedAt: 1, cwd: "/synthetic", sessionFile: workerSession, subscriptions: [], isActive: true });
  const graph = new DurableGraphTaskAuthority();
  const definition = { operationId: "apply", tasks: [{ key: "work", title: "Work", goal: "Complete work.", assignee: "worker" }] };
  await graph.applyGraph(name, definition);
  const task = (await graph.readTasks(name))[0];
  const register = (actor: string) => {
    vi.stubEnv("PI_TEAM_NAME", name); vi.stubEnv("PI_AGENT_NAME", actor === "team-lead" ? "" : actor);
    const tools = new Map<string, any>();
    piTeams({ registerTool: (tool: any) => tools.set(tool.name, tool), on() {}, sendMessage: vi.fn(), appendEntry: vi.fn() } as never);
    return tools;
  };
  const context = (sessionFile: string) => ({ sessionManager: { getSessionFile: () => sessionFile, buildContextEntries: () => [] }, ui: { notify: vi.fn(), setStatus: vi.fn() } });
  return { name, graph, task, definition, leadSession, workerSession, register, context };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const name of names.splice(0)) fs.rmSync(paths.teamDir(name), { force: true, recursive: true }); });

for (const [actor, toolName] of [["worker", "task_update"], ["team-lead", "task_update"], ["team-lead", "task_graph_apply"]]) {
  it.each(["replacement", "shutdown", "session-change"])(`refuses registered ${actor} ${toolName} after %s at authority entry`, async mode => {
    const f = await fixture();
    const member = await teams.currentMembership(f.name, actor);
    const tools = f.register(actor);
    const entered = deferred(), gate = deferred();
    const method = toolName === "task_graph_apply" ? "applyGraph" : "transition";
    const original = DurableGraphTaskAuthority.prototype[method];
    vi.spyOn(DurableGraphTaskAuthority.prototype, method).mockImplementation(async function(this: DurableGraphTaskAuthority, ...args: any[]) {
      entered.resolve(); await gate.promise; return (original as any).apply(this, args);
    });
    const before = fs.readFileSync(paths.graphTaskAuthorityPath(f.name));
    const parameters = toolName === "task_graph_apply"
      ? { operation_id: "old-apply", tasks: [{ ...f.definition.tasks[0], goal: "Changed goal." }] }
      : { task_id: f.task.id, operation_id: "old-update", expected_version: f.task.version, ...(actor === "worker" ? { transition: "claim" } : { current_context: "Changed context." }) };
    const operation = tools.get(toolName).execute("old-call", parameters, undefined, undefined, f.context(actor === "worker" ? f.workerSession : f.leadSession));
    await entered.promise;
    if (mode === "shutdown") {
      await runtime.writeRuntimeStatus(f.name, "worker", { lastStop: { piReason: "new", observedAt: 1, suspectedHumanStop: false } }, "old-worker");
      const lifecycle = new TeamLifecycleService({ assignedWorkGuard: {
        nonterminalTaskIds: async name => (await f.graph.readTasks(name)).map(task => task.id),
        nonterminalTaskIdsAssignedToWorker: async name => (await f.graph.readTasks(name)).map(task => task.id),
      }, lifecyclePublication: new DurableTeamLifecyclePublication() });
      expect((await lifecycle.shutdownTeam(f.name)).kind).toBe("shutdown");
    } else if (mode === "replacement") {
      await teams.withCurrentMembershipLease(f.name, member.membershipId!, () => teams.deactivateMembership(f.name, member.membershipId!, "replaced"));
      const replacement = { ...member, membershipId: "replacement", sessionFile: "/synthetic/replacement", isActive: true };
      if (actor === "team-lead") {
        const config = await teams.readConfig(f.name); config.members.push(replacement); writeJsonFixture(paths.configPath(f.name), config);
      } else await teams.addMember(f.name, replacement);
    } else {
      const config = await teams.readConfig(f.name);
      config.members.find(candidate => candidate.membershipId === member.membershipId)!.sessionFile = "/synthetic/resumed";
      writeJsonFixture(paths.configPath(f.name), config);
    }
    gate.resolve();
    expect((await operation).details).toMatchObject({ kind: "refused", state_changed: false });
    expect(fs.readFileSync(paths.graphTaskAuthorityPath(f.name))).toEqual(before);
  });
}

it("holds the exact Membership lease through the registered graph commit", async () => {
  const f = await fixture(), tools = f.register("worker");
  const entered = deferred(), gate = deferred();
  const original = teams.withCurrentSessionBinding;
  vi.spyOn(teams, "withCurrentSessionBinding").mockImplementation((name, actor, session, membership, action) => original(name, actor, session, membership, async (config, member) => {
    entered.resolve(); await gate.promise; return action(config, member);
  }));
  const operation = tools.get("task_update").execute("claim", { task_id: f.task.id, operation_id: "claim", expected_version: f.task.version, transition: "claim" }, undefined, undefined, f.context(f.workerSession));
  await entered.promise;
  let retired = false;
  const replacement = teams.withCurrentMembershipLease(f.name, "old-worker", async () => { await teams.deactivateMembership(f.name, "old-worker", "replaced"); retired = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(retired).toBe(false);
  gate.resolve();
  expect((await operation).details.kind).toBe("updated");
  await replacement; expect(retired).toBe(true);
});

it.each(["worker_stop", "team_shutdown"])("returns typed unavailable from registered %s on unsupported storage", async toolName => {
  const f = await fixture();
  fs.rmSync(path.dirname(paths.graphTaskAuthorityPath(f.name)), { recursive: true });
  const config = await teams.readConfig(f.name); Object.assign(config, { taskBackend: "beads" }); writeJsonFixture(paths.configPath(f.name), config);
  const before = fs.readFileSync(paths.configPath(f.name));
  const result = await f.register("team-lead").get(toolName).execute("stop", toolName === "worker_stop" ? { worker: "worker" } : {}, undefined, undefined, f.context(f.leadSession));
  expect(result.details).toMatchObject({ kind: "unavailable", reason: "team_authority_unavailable", message: UNSUPPORTED_BEADS_TEAM, state_changed: false });
  expect(fs.readFileSync(paths.configPath(f.name))).toEqual(before);
  expect(fs.existsSync(path.dirname(paths.graphTaskAuthorityPath(f.name)))).toBe(false);
});
