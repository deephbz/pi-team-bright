import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
  TaskCreateParametersSchema,
  TaskCreateResultSchema,
  TeamCreateParametersSchema,
} from "./catalog";
import { InMemoryModelToolTeamPort, exactLeaderSessionId, registerModelToolJourney } from "./runtime";
import { ModelResultSchemas, projectToolResult } from "./result-projection";
import { projectTui } from "./tui-projection";

type RegisteredTool = {
  name: string;
  parameters: unknown;
  execute: (id: string, params: any, signal: AbortSignal, onUpdate: undefined, ctx: any) => Promise<any>;
};

function journey() {
  const tools = new Map<string, RegisteredTool>();
  const port = new InMemoryModelToolTeamPort();
  registerModelToolJourney({ registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) }, port);
  const session = "019fc274-f97e-7910-b6b6-579a20b3b1d0";
  const context = { sessionManager: { getSessionId: () => session } };
  const invoke = async (name: string, params: unknown) => {
    const tool = tools.get(name)!;
    if (!Check(tool.parameters as any, params)) throw new Error(`Provider schema rejected ${name} parameters.`);
    return tool.execute(`${name}-call`, params, new AbortController().signal, undefined, context);
  };
  return { tools, port, session: exactLeaderSessionId(session), invoke };
}

const dagCall = {
  operation_id: "release-dag-1",
  tasks: [
    { key: "plan", title: "Plan", goal: "Approve an implementation plan.", assignee: "maker" },
    { key: "impl", title: "Implement", goal: "Implement the approved plan.", assignee: "maker", needs: ["plan"] },
    { key: "review", title: "Review", goal: "Review the implementation.", assignee: "reviewer", needs: ["impl"] },
    { key: "verify", title: "Verify", goal: "Verify the reviewed result.", assignee: "reviewer", needs: ["review"] },
  ],
} as const;

describe("DAG-native model-tool journey", () => {
  it("registers one atomic graph create tool and removes task_link", () => {
    const { tools } = journey();
    expect([...tools.keys()]).toEqual([
      "team_create", "team_sync", "ensure_worker", "task_create", "task_read",
      "task_update", "worker_stop", "team_shutdown", "alert_send",
    ]);
    expect(tools.get("team_create")!.parameters).toBe(TeamCreateParametersSchema);
    expect(tools.get("task_create")!.parameters).toBe(TaskCreateParametersSchema);
    expect(tools.has("task_link")).toBe(false);
    expect(Check(TaskCreateParametersSchema, dagCall)).toBe(true);
    expect(Check(TaskCreateParametersSchema, { tasks: dagCall.tasks })).toBe(false);
  });

  it("creates a four-Task DAG atomically across two stable Workers", async () => {
    const { invoke } = journey();
    await invoke("team_create", { name: "release-team", purpose: "Prepare the release." });
    await invoke("ensure_worker", { name: "maker", scope: "Own release implementation." });
    await invoke("ensure_worker", { name: "reviewer", scope: "Own independent review and verification." });

    const result = await invoke("task_create", dagCall);
    expect(Check(TaskCreateResultSchema, result.details)).toBe(true);
    expect(result.details.kind).toBe("task_graph_created");
    const cards = result.details.tasks_by_key;
    expect(Object.keys(cards)).toEqual(["plan", "impl", "review", "verify"]);
    expect(result.details.ready_task_ids).toEqual([cards.plan.id]);
    expect(cards.impl.relations).toEqual([{ relation: "blocked_by", target_task_id: cards.plan.id }]);
    expect(cards.impl.dependency_state).toEqual({ kind: "waiting", active_blocker_ids: [cards.plan.id] });
  });

  it("makes graph creation all-or-nothing and replay-safe", async () => {
    const { invoke, port, session } = journey();
    await invoke("team_create", { name: "release-team", purpose: "Prepare the release." });
    await invoke("ensure_worker", { name: "maker", scope: "Own release implementation." });
    await invoke("ensure_worker", { name: "reviewer", scope: "Own independent review and verification." });

    const bad = await invoke("task_create", {
      ...dagCall,
      operation_id: "bad-cycle",
      tasks: dagCall.tasks.map(task => task.key === "plan" ? { ...task, needs: ["verify"] } : task),
    });
    expect(bad.details).toMatchObject({ kind: "refused", reason: "graph_conflict", state_changed: false });
    const empty = await port.readSnapshot(session);
    expect(empty.kind === "snapshot" && empty.tasks).toHaveLength(0);

    const first = (await invoke("task_create", dagCall)).details;
    const replay = (await invoke("task_create", dagCall)).details;
    expect(replay.replayed).toBe(true);
    expect(Object.fromEntries(Object.entries(replay.tasks_by_key).map(([key, task]: [string, any]) => [key, task.id])))
      .toEqual(Object.fromEntries(Object.entries(first.tasks_by_key).map(([key, task]: [string, any]) => [key, task.id])));
    const snapshot = await port.readSnapshot(session);
    expect(snapshot.kind === "snapshot" && snapshot.tasks).toHaveLength(4);

    const changed = await invoke("task_create", { ...dagCall, tasks: dagCall.tasks.map((task, index) => index ? task : { ...task, title: "Changed" }) });
    expect(changed.details).toMatchObject({ kind: "refused", reason: "operation_conflict", state_changed: false });
  });

  it("keeps existing-Task expansion out of the frequent create grammar", () => {
    expect(Check(TaskCreateParametersSchema, {
      operation_id: "expand-existing-dependent",
      tasks: [{ key: "audit", title: "Audit", goal: "Verify the release.", assignee: "reviewer" }],
      dependencies: [{ task: { task_id: "task-release", expected_version: "v_0123456789abcdef" }, needs: [{ key: "audit" }] }],
    })).toBe(false);
  });

  it("uses one scalar Alert target and refuses invalid fanout before authority", async () => {
    const { invoke } = journey();
    await invoke("team_create", { name: "release-team", purpose: "Prepare the release." });
    await invoke("ensure_worker", { name: "reviewer", scope: "Own independent review." });

    const sent = await invoke("alert_send", { to: "reviewer", kind: "attention", text: "Review the result." });
    expect(sent.details).toMatchObject({ kind: "alert_sent", accepted_recipients: ["reviewer"] });
    const refused = await invoke("alert_send", { to: "*", kind: "attention", text: "Invalid fanout." });
    expect(refused.details).toMatchObject({ kind: "refused", reason: "invalid_fanout", state_changed: false });
    const missingTask = await invoke("alert_send", { to: "reviewer", kind: "attention", text: "Invalid reference.", task_version: "v_0123456789abcdef" });
    expect(missingTask.details).toMatchObject({ kind: "refused", reason: "invalid_fanout", state_changed: false });
  });

  it("keeps raw, model, collapsed TUI, and expanded TUI projections consistent", async () => {
    const { invoke } = journey();
    await invoke("team_create", { name: "release-team", purpose: "Prepare the release." });
    await invoke("ensure_worker", { name: "maker", scope: "Own release implementation." });
    await invoke("ensure_worker", { name: "reviewer", scope: "Own independent review and verification." });
    const raw = (await invoke("task_create", dagCall)).details;
    const model = projectToolResult("task_create", raw) as any;
    expect(Check(ModelResultSchemas.task_create, model)).toBe(true);
    expect(model.ready_task_ids).toEqual(raw.ready_task_ids);
    expect(model.tasks_by_key.impl.dependency_state).toEqual(raw.tasks_by_key.impl.dependency_state);
    expect(projectTui({ tool: "task_create", details: raw, expanded: false }).join("\n")).toContain("4 Task DAG committed");
    const expanded = projectTui({ tool: "task_create", details: raw, expanded: true }).join("\n");
    expect(expanded).toContain('"impl"');
    expect(expanded).toContain(raw.tasks_by_key.plan.id);
  });
});
