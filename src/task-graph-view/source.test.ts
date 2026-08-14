import { describe, expect, it } from "vitest";
import { GraphTaskController, type GraphTaskTransition } from "../task-authority/graph-control";
import { taskVersionRef } from "../task-authority/task-version-ref";
import type { TaskCard } from "../task-authority/task-domain";
import {
  parseTaskGraphLimit,
  parseTaskGraphViewSource,
  parseTaskGraphViewSourceJson,
  projectGraphControlTaskGraphViewSource,
  projectTaskGraphViewSource,
  selectVisibleTaskGraph,
  TASK_GRAPH_MAX_SOURCE_BYTES,
  TASK_GRAPH_VIEW_SCHEMA,
} from "./source";

const aliases = { default: "openai/default:medium", capable: "openai/capable:max" };

function transition(
  controller: GraphTaskController,
  taskId: string,
  value: GraphTaskTransition,
  operation: string,
  evidence?: string,
): void {
  const task = controller.readTask(taskId);
  controller.transition({
    taskId,
    operationId: operation,
    expectedVersion: task.version,
    transition: value,
    worker: task.assignee,
    ...(evidence ? { evidence } : {}),
  });
}

function achieve(controller: GraphTaskController, taskId: string): void {
  transition(controller, taskId, "claim", `${taskId}-claim`);
  transition(controller, taskId, "goal_achieved", `${taskId}-achieve`, `${taskId} passed.`);
}

function graphControlSource() {
  const controller = new GraphTaskController(aliases);
  controller.applyGraph({
    operationId: "graph",
    tasks: [
      { key: "implement", title: "Implement", goal: "Implement.", assignee: "builder", modelAlias: "capable" },
      {
        key: "review",
        title: "Review",
        goal: "Review.",
        assignee: "reviewer",
        needs: ["implement"],
        onGoalFailed: { target: "implement", maxTraversals: 2 },
      },
      { key: "verify", title: "Verify", goal: "Verify.", assignee: "verifier", needs: ["review"] },
      { key: "active", title: "Active", goal: "Stay active.", assignee: "active-worker" },
      { key: "blocked", title: "Blocked", goal: "Hit an external block.", assignee: "blocked-worker" },
      { key: "failed", title: "Failed", goal: "Fail its criterion.", assignee: "failed-worker" },
      { key: "left", title: "Left", goal: "Pass left.", assignee: "left-worker" },
      { key: "right", title: "Right", goal: "Pass right.", assignee: "right-worker" },
      { key: "join", title: "Join", goal: "Join both.", assignee: "join-worker", needs: ["left", "right"] },
      { key: "cancelled", title: "Cancelled", goal: "Be cancelled.", assignee: "cancel-worker" },
      { key: "ready", title: "Ready", goal: "Remain ready.", assignee: "ready-worker" },
    ],
  });
  achieve(controller, "implement");
  transition(controller, "review", "claim", "review-claim");
  transition(controller, "review", "goal_failed", "review-fail", "Review criterion failed.");
  transition(controller, "active", "claim", "active-claim");
  transition(controller, "blocked", "claim", "blocked-claim");
  transition(controller, "blocked", "block", "blocked-block", "External service is unavailable.");
  transition(controller, "failed", "claim", "failed-claim");
  transition(controller, "failed", "goal_failed", "failed-fail", "Criterion failed.");
  achieve(controller, "left");
  achieve(controller, "right");
  transition(controller, "cancelled", "cancel", "cancelled-cancel", "Operator cancelled this branch.");
  return projectGraphControlTaskGraphViewSource({ teamName: "graph-team", trace: controller.trace() });
}

function legacyTask(input: {
  id: string;
  status?: TaskCard["status"];
  dependency?: "ready" | "waiting" | "terminal";
  blockers?: string[];
  blockedBy?: string[];
  title?: string;
}): TaskCard {
  const status = input.status ?? "open";
  const kind = input.dependency ?? (status === "blocked" || status === "closed" ? "terminal" : "ready");
  return {
    id: input.id,
    title: input.title ?? `Task ${input.id}`,
    goal: `Goal ${input.id}`,
    current_context: "Current context.",
    status,
    relations: (input.blockedBy ?? []).map((target_task_id) => ({ relation: "blocked_by" as const, target_task_id })),
    dependency_state: { kind, active_blocker_ids: input.blockers ?? [] },
    version: taskVersionRef(input.id),
  } as TaskCard;
}

describe("Task graph view source", () => {
  it("projects graph-control states, typed edges, loop traversal, joins, Attempts, and model aliases", () => {
    const source = graphControlSource();
    const state = Object.fromEntries(source.nodes.map((node) => [node.id, node.state]));
    expect(source).toMatchObject({ schema: TASK_GRAPH_VIEW_SCHEMA, authority: "graph_control" });
    expect(source.graph_version).toMatch(/^g_/);
    expect(source.authority_sequence).toMatch(/^[1-9][0-9]*$/);
    expect(state).toMatchObject({
      implement: "ready",
      review: "dependency_waiting",
      verify: "dependency_waiting",
      active: "in_progress",
      blocked: "blocked",
      failed: "goal_failed",
      left: "goal_achieved",
      join: "ready",
      cancelled: "cancelled",
    });
    expect(source.nodes.find((node) => node.id === "implement")).toMatchObject({
      goal: "Implement.",
      current_context: "Work has not started.",
      model_alias: "capable",
      attempts_started: 1,
      display_attempt: {
        ordinal: 1,
        state: "completed",
        current: false,
        outcome: "goal_achieved",
        model_alias: "capable",
        resolved_model: aliases.capable,
      },
    });
    expect(source.nodes.find((node) => node.id === "review")?.display_attempt).toMatchObject({
      outcome: "goal_failed",
      current: false,
    });
    expect(source.nodes.find((node) => node.id === "failed")?.failure_reason).toBe("criterion_failed");
    expect(source.edges).toContainEqual({
      from_task_id: "review",
      to_task_id: "implement",
      kind: "goal_failed",
      traversals: 1,
      max_traversals: 2,
    });
    expect(source.edges).toContainEqual({ from_task_id: "implement", to_task_id: "review", kind: "goal_achieved" });
    expect(selectVisibleTaskGraph(source, "all").joinTaskIds.has("join")).toBe(true);
    const raw = JSON.stringify(source);
    expect(raw).not.toContain("Review criterion failed");
    expect(raw).toContain('"goal":"Review."');
  });

  it("includes graph authority sequence in freshness even when activity does not change", () => {
    const controller = new GraphTaskController(aliases);
    controller.applyGraph({ operationId: "graph", tasks: [
      { key: "task", title: "Task", goal: "Pass.", assignee: "worker" },
    ] });
    const activity = {
      headCursor: "7",
      tasks: [{
        taskId: "task",
        cursor: "7",
        firstActivityAt: "2026-08-14T08:00:00.000Z",
        lastActivityAt: "2026-08-14T08:05:00.000Z",
      }],
    };
    const before = projectGraphControlTaskGraphViewSource({ teamName: "graph-team", trace: controller.trace(), activity });
    transition(controller, "task", "claim", "task-claim");
    const after = projectGraphControlTaskGraphViewSource({ teamName: "graph-team", trace: controller.trace(), activity });
    expect(before.nodes[0]).toMatchObject({
      first_activity_at: "2026-08-14T08:00:00.000Z",
      last_activity_at: "2026-08-14T08:05:00.000Z",
    });
    expect(BigInt(after.authority_sequence!)).toBeGreaterThan(BigInt(before.authority_sequence!));
    expect(after.source_revision).not.toBe(before.source_revision);
    expect(after.nodes[0].state).toBe("in_progress");
  });

  it("ignores removed historical activity outside the current graph revision", () => {
    const source = graphControlSource();
    const projected = projectGraphControlTaskGraphViewSource({
      teamName: source.team_name,
      trace: (() => {
        const controller = new GraphTaskController(aliases);
        controller.applyGraph({ operationId: "small-graph", tasks: [
          { key: "current", title: "Current", goal: "Stay current.", assignee: "worker" },
        ] });
        return controller.trace();
      })(),
      activity: {
        headCursor: "99",
        tasks: [
          { taskId: "removed-history", cursor: "99" },
          { taskId: "current", cursor: "2" },
        ],
      },
    });
    expect(projected.nodes).toHaveLength(1);
    expect(projected.nodes[0]).toMatchObject({ id: "current", activity_cursor: "2" });
    expect(projected.source_revision.startsWith("99-")).toBe(true);
  });

  it("keeps live legacy cards usable without certifying closed as goal achievement", () => {
    const tasks = [
      legacyTask({ id: "done", status: "closed" }),
      legacyTask({ id: "waiting", dependency: "waiting", blockers: ["done"], blockedBy: ["done"], title: "wait\u001b[31m now\nnext" }),
    ];
    const source = projectTaskGraphViewSource({
      teamName: "legacy-team",
      tasks,
      activity: { headCursor: "2", tasks: tasks.map((task, index) => ({ taskId: task.id, cursor: String(index + 1) })) },
    });
    expect(source.authority).toBe("legacy_task_cards");
    expect(source.nodes.find((node) => node.id === "done")?.state).toBe("legacy_completed");
    expect(source.nodes.find((node) => node.id === "waiting")?.title).toBe("wait now next");
    expect(source.edges).toEqual([{ from_task_id: "done", to_task_id: "waiting", kind: "legacy_dependency" }]);
    expect(JSON.stringify(source)).not.toContain("\u001b");
  });

  it("filters before applying the recent limit and reports each omission class", () => {
    const tasks = [
      ...Array.from({ length: 30 }, (_, index) => legacyTask({ id: `closed-${index}`, status: "closed" })),
      ...Array.from({ length: 30 }, (_, index) => legacyTask({ id: `ready-${index}` })),
    ];
    const source = projectTaskGraphViewSource({
      teamName: "filter-team",
      tasks,
      activity: {
        headCursor: "60",
        tasks: tasks.map((task, index) => ({ taskId: task.id, cursor: String(index + 1) })),
      },
    });
    const visible = selectVisibleTaskGraph(source, 25, "actionable");
    expect(visible.nodes).toHaveLength(25);
    expect(visible.nodes.every((node) => node.state === "ready")).toBe(true);
    expect(visible.recencyOmittedNodeCount).toBe(5);
    expect(visible.filterOmittedNodeCount).toBe(30);
    expect(visible.omittedNodeCount).toBe(35);
  });

  it("bounds recency and reports omitted graph boundaries without changing waiting state", () => {
    const root = legacyTask({ id: "root" });
    const extras = Array.from({ length: 30 }, (_, index) => legacyTask({
      id: `extra-${index}`,
      ...(index === 29 ? { dependency: "waiting" as const, blockers: ["root"], blockedBy: ["root"] } : {}),
    }));
    const source = projectTaskGraphViewSource({
      teamName: "large-team",
      tasks: [root, ...extras],
      activity: {
        headCursor: "30",
        tasks: extras.map((task, index) => ({ taskId: task.id, cursor: String(index + 1) })),
      },
    });
    const visible = selectVisibleTaskGraph(source, 25);
    expect(visible.nodes).toHaveLength(25);
    expect(visible.nodes[0].id).toBe("extra-29");
    expect(visible.nodes[0].state).toBe("dependency_waiting");
    expect(visible.omittedNodeCount).toBe(6);
    expect(visible.boundaryEdgeCount).toBe(1);
  });

  it("rejects malformed authority, dangling and cyclic edges, oversized input, and unsupported limits", () => {
    const source = graphControlSource();
    expect(() => parseTaskGraphViewSource({ ...source, nodes: [...source.nodes, source.nodes[0]] })).toThrow(/duplicate node/i);
    expect(() => parseTaskGraphViewSource({
      ...source,
      edges: [...source.edges, { from_task_id: "missing", to_task_id: "ready", kind: "goal_achieved" }],
    })).toThrow(/dangling endpoint/i);
    expect(() => parseTaskGraphViewSource({ ...source, team_name: "bad\u001bteam" })).toThrow(/terminal control/i);
    expect(() => parseTaskGraphViewSource({
      ...source,
      nodes: source.nodes.map((node) => node.state === "dependency_waiting"
        ? { ...node, state: "ready", waiting_on_task_ids: [] }
        : node),
      edges: [
        { from_task_id: "active", to_task_id: "blocked", kind: "goal_achieved" },
        { from_task_id: "blocked", to_task_id: "active", kind: "goal_achieved" },
      ],
    })).toThrow(/success dependency cycle/i);
    expect(() => parseTaskGraphViewSource({ ...source, graph_version: undefined })).toThrow(/graph_version/i);
    expect(() => parseTaskGraphViewSource({ ...source, authority_sequence: undefined })).toThrow(/authority_sequence/i);
    expect(() => parseTaskGraphViewSource({ ...source, authority_sequence: "0" })).not.toThrow();
    expect(() => parseTaskGraphViewSource({ ...source, authority: "legacy_task_cards" })).toThrow(/graph_version/i);
    expect(() => parseTaskGraphViewSourceJson("x".repeat(TASK_GRAPH_MAX_SOURCE_BYTES + 1))).toThrow(/exceeds/i);
    expect(parseTaskGraphLimit("")).toBe(50);
    expect(parseTaskGraphLimit("200")).toBe(200);
    expect(parseTaskGraphLimit("ALL")).toBe("all");
    expect(() => parseTaskGraphLimit("51")).toThrow(/must be one of/i);
  });
});
