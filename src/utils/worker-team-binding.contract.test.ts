import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import piTeams from "../../extensions/index";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import { AlertSendParametersSchema, TaskReadParametersSchema, TaskUpdateParametersSchema } from "../model-tool-contract/catalog";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "../model-tool-contract/model-tool-constants";
import * as paths from "./paths";
import * as teamEvents from "./team-events";
import * as teams from "./teams";
import type { Member } from "./models";

type Tool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<any>;
};

const createdTeams: string[] = [];

function registerWorker(teamName: string): Map<string, Tool> {
  vi.stubEnv("PI_AGENT_NAME", "worker");
  vi.stubEnv("PI_TEAM_NAME", teamName);
  const tools = new Map<string, Tool>();
  piTeams({
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    on() {},
    sendUserMessage() {},
  } as never);
  return tools;
}

function registerLeader(): Map<string, Tool> {
  vi.stubEnv("PI_AGENT_NAME", "");
  vi.stubEnv("PI_TEAM_NAME", "");
  const tools = new Map<string, Tool>();
  piTeams({
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    on() {},
    sendUserMessage() {},
  } as never);
  return tools;
}

function workerMember(teamName: string, sessionFile: string): Member {
  return {
    membershipId: teams.newMembershipId(),
    agentId: `worker@${teamName}`,
    name: "worker",
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile,
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
  };
}

async function createBoundTeam(teamName: string, workerSession: string): Promise<void> {
  const leadSession = `/tmp/${teamName}-lead.jsonl`;
  await teams.createTeam(
    teamName,
    leadSession,
    `lead@${teamName}`,
    "Worker binding contract",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    MODEL_TOOL_IMPLEMENTATION_VERSION,
  );
  await teams.addMember(teamName, workerMember(teamName, workerSession));
  createdTeams.push(teamName);
}

function context(sessionFile: string) {
  return { sessionManager: { getSessionFile: () => sessionFile }, ui: { notify() {} } };
}

const task = {
  id: "task-binding",
  title: "Binding Task",
  goal: "Prove the Worker uses its exact Team binding.",
  status: "in_progress" as const,
  assignee: "worker",
  current_context: "Worker is verifying the exact binding.",
  version: taskVersionRef("beads_binding_version"),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
});

describe("narrow Worker Team binding surface", () => {
  it("exposes only the three Worker capabilities and omits team_name from every Worker schema", () => {
    const tools = registerWorker("worker-schema-team");

    expect([...tools.keys()].sort()).toEqual(["alert_send", "task_read", "task_update"]);
    expect(tools.get("task_read")!.parameters).toMatchObject({
      properties: { task_id: expect.anything() },
    });
    expect((tools.get("task_read")!.parameters as any).properties).not.toHaveProperty("team_name");
    expect((tools.get("task_update")!.parameters as any).properties).not.toHaveProperty("team_name");
    expect((tools.get("alert_send")!.parameters as any).properties).not.toHaveProperty("team_name");

    expect(Check(tools.get("task_read")!.parameters as any, { task_id: "task-binding" })).toBe(true);
    expect(Check(tools.get("task_read")!.parameters as any, { team_name: "other-team", task_id: "task-binding" })).toBe(false);
    expect(Check(tools.get("task_update")!.parameters as any, {
      task_id: "task-binding",
      operation_id: "worker-update",
      status: "in_progress",
      expected_version: task.version,
    })).toBe(true);
    expect(Check(tools.get("task_update")!.parameters as any, {
      task_id: "task-binding",
      operation_id: "worker-claim",
      claim: true,
      expected_version: task.version,
    })).toBe(true);
    expect(Check(tools.get("task_update")!.parameters as any, {
      team_name: "other-team",
      task_id: "task-binding",
      operation_id: "worker-update",
      status: "in_progress",
      expected_version: task.version,
    })).toBe(false);
    expect(Check(tools.get("alert_send")!.parameters as any, { kind: "attention", text: "Needs review." })).toBe(true);
    expect(Check(tools.get("alert_send")!.parameters as any, { team_name: "other-team", kind: "attention", text: "Must be rejected." })).toBe(false);
  });

  it("keeps the leader schemas and ten-tool capability unchanged", () => {
    const tools = registerLeader();

    expect([...tools.keys()].sort()).toEqual([
      "alert_send",
      "ensure_worker",
      "task_create",
      "task_link",
      "task_read",
      "task_update",
      "team_create",
      "team_shutdown",
      "team_sync",
      "worker_stop",
    ]);
    expect(Check(TaskReadParametersSchema, { task_ids: ["task-binding"] })).toBe(true);
    expect(Check(TaskReadParametersSchema, { task_id: "task-binding" })).toBe(false);
    expect(Check(TaskUpdateParametersSchema, { updates: [{ task_id: "task-binding", operation_id: "leader-update", expected_version: task.version, status: "open" }] })).toBe(true);
    expect(Check(TaskUpdateParametersSchema, { task_id: "task-binding", operation_id: "leader-update", expected_version: task.version, status: "open" })).toBe(false);
    expect(Check(AlertSendParametersSchema, { target: { kind: "worker", name: "worker" }, kind: "attention", text: "Review this." })).toBe(true);
    expect(Check(AlertSendParametersSchema, { kind: "attention", text: "Worker form must not become the leader form." })).toBe(false);
    expect(tools.get("task_read")!.parameters).toBe(TaskReadParametersSchema);
    expect(tools.get("task_update")!.parameters).toBe(TaskUpdateParametersSchema);
    expect(tools.get("alert_send")!.parameters).toBe(AlertSendParametersSchema);
    expect((tools.get("task_read")!.parameters as any).properties).toHaveProperty("task_ids");
    expect((tools.get("task_update")!.parameters as any).properties).toHaveProperty("updates");
  });

  it("uses the exact Worker Team, Membership, and Session for Task execution", async () => {
    const teamA = `worker-binding-a-${process.pid}-${Date.now()}`;
    const teamB = `worker-binding-b-${process.pid}-${Date.now()}`;
    const sessionA = `/tmp/${teamA}-worker.jsonl`;
    await createBoundTeam(teamA, sessionA);
    await createBoundTeam(teamB, `/tmp/${teamB}-worker.jsonl`);
    const read = vi.spyOn(BeadsTaskAdapter.prototype, "read").mockResolvedValue({
      kind: "found",
      task,
    });
    const update = vi.spyOn(BeadsTaskAdapter.prototype, "update").mockResolvedValue({
      kind: "updated",
      taskId: task.id,
      operationId: "worker-update",
      task,
      journalEntries: [],
    });
    const claim = vi.spyOn(BeadsTaskAdapter.prototype, "claim").mockResolvedValue({
      kind: "updated",
      taskId: task.id,
      operationId: "worker-claim",
      task,
      journalEntries: [],
    });
    const tools = registerWorker(teamA);

    const readResult = await tools.get("task_read")!.execute(
      "read",
      { task_id: task.id, team_name: teamB },
      undefined,
      undefined,
      context(sessionA),
    );
    const updateResult = await tools.get("task_update")!.execute(
      "update",
      {
        task_id: task.id,
        operation_id: "worker-update",
        status: "in_progress",
        expected_version: task.version,
        team_name: teamB,
      },
      undefined,
      undefined,
      context(sessionA),
    );
    const claimResult = await tools.get("task_update")!.execute(
      "claim",
      {
        task_id: task.id,
        operation_id: "worker-claim",
        claim: true,
        expected_version: task.version,
        team_name: teamB,
      },
      undefined,
      undefined,
      context(sessionA),
    );

    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.instances[0]).toMatchObject({ teamName: teamA, actor: "worker" });
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.instances[0]).toMatchObject({ teamName: teamA, actor: "worker" });
    expect(claim).toHaveBeenCalledOnce();
    expect(claim.mock.instances[0]).toMatchObject({ teamName: teamA, actor: "worker" });
    expect(readResult.details).toMatchObject({ kind: "task_read_batch", outcomes: [{ kind: "found", task_id: task.id }] });
    expect(updateResult.details).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "updated", task_id: task.id, operation_id: "worker-update" }] });
    expect(claimResult.details).toMatchObject({ kind: "task_update_batch", outcomes: [{ kind: "updated", task_id: task.id, operation_id: "worker-claim" }] });
    await expect(tools.get("task_update")!.execute(
      "invalid-claim",
      {
        task_id: task.id,
        operation_id: "invalid-claim",
        claim: true,
        status: "in_progress",
        expected_version: task.version,
      },
      undefined,
      undefined,
      context(sessionA),
    )).rejects.toThrow(/claim=true is atomic/);
    expect(claim).toHaveBeenCalledOnce();
    await expect(tools.get("task_read")!.execute(
      "stale-session",
      { task_id: task.id },
      undefined,
      undefined,
      context(`/tmp/${teamA}-wrong-session.jsonl`),
    )).rejects.toThrow(/Worker Session binding is unavailable|not the current binding/);
  });

  it("sends Worker Alerts only to team-lead in the exact bound Team", async () => {
    const teamA = `worker-alert-binding-a-${process.pid}-${Date.now()}`;
    const teamB = `worker-alert-binding-b-${process.pid}-${Date.now()}`;
    const sessionA = `/tmp/${teamA}-worker.jsonl`;
    await createBoundTeam(teamA, sessionA);
    await createBoundTeam(teamB, `/tmp/${teamB}-worker.jsonl`);
    const tools = registerWorker(teamA);

    const sent = await tools.get("alert_send")!.execute(
      "alert",
      { kind: "attention", text: "Use the exact Team binding.", team_name: teamB },
      undefined,
      undefined,
      context(sessionA),
    );

    expect(sent.details).toMatchObject({
      kind: "alert_sent",
      accepted_recipients: ["team-lead"],
      failed_recipients: [],
      task_state_changed: false,
    });
    expect(teamEvents.readTeamEvents(teamA, { eventTypes: ["alert"] }).events).toEqual([
      expect.objectContaining({ from: "worker", to: "team-lead", kind: "attention" }),
    ]);
    expect(teamEvents.readTeamEvents(teamB, { eventTypes: ["alert"] }).events).toEqual([]);
  });
});
