import { afterEach, describe, expect, it, vi } from "vitest";
import * as teams from "../utils/teams";
import { DurableModelToolBindings } from "./durable-model-tool-bindings";
import { DurableModelToolTaskApplication } from "./durable-model-tool-task-application";
import { exactLeaderSessionId } from "./model-tool-contracts";
import type { GraphTaskOrchestrationPort } from "../task-authority/graph-orchestration";

const leader = exactLeaderSessionId("leader-session");
const graph = {
  applyGraph: vi.fn(),
  readTasks: vi.fn(),
  transition: vi.fn(),
} as unknown as GraphTaskOrchestrationPort;

function application() {
  const bindings = new DurableModelToolBindings();
  bindings.setLeaderSessionFile(leader, "/tmp/leader.jsonl");
  return new DurableModelToolTaskApplication(bindings, graph);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(graph.applyGraph).mockReset();
  vi.mocked(graph.readTasks).mockReset();
  vi.mocked(graph.transition).mockReset();
});

describe("durable graph Task application", () => {
  it("fails closed when the exact leader Session has no current Team binding", async () => {
    vi.spyOn(teams, "resolveCurrentLeadSessionBinding").mockResolvedValue({ status: "not_found" } as any);
    const result = await application().createTaskGraph(leader, {
      operationId: "create",
      tasks: [{ key: "task", title: "Task", goal: "Verify graph authority.", assignee: "worker" }],
    });
    expect(result).toMatchObject({ kind: "no_active_team", operationId: "create" });
    expect(graph.applyGraph).not.toHaveBeenCalled();
  });

  it("maps a committed graph apply to tasks keyed by the caller's graph keys", async () => {
    const task = { id: "task", title: "Task", goal: "Verify graph authority.", assignee: "worker", version: "v_0123456789abcdef" } as any;
    vi.spyOn(teams, "resolveCurrentLeadSessionBinding").mockResolvedValue({ status: "bound", teamName: "team", member: { name: "team-lead", membershipId: "lead-membership" } } as any);
    vi.spyOn(teams, "readConfig").mockResolvedValue({ name: "team" } as any);
    vi.mocked(graph.applyGraph).mockResolvedValue({
      kind: "applied", operationId: "create", replayed: false, graphVersion: "g_0123456789abcdef",
      tasks: [task], readyTaskIds: ["task"], deliveryWarnings: [],
    } as any);

    const result = await application().createTaskGraph(leader, {
      operationId: "create",
      tasks: [{ key: "task", title: "Task", goal: "Verify graph authority.", assignee: "worker" }],
    });

    expect(result).toMatchObject({ kind: "created", tasksByKey: { task }, readyTaskIds: ["task"] });
    expect(graph.applyGraph).toHaveBeenCalledWith("team", {
      operationId: "create",
      tasks: [{ key: "task", title: "Task", goal: "Verify graph authority.", assignee: "worker" }],
    }, { agentName: "team-lead", membershipId: "lead-membership", sessionFile: "/tmp/leader.jsonl" });
  });
});
