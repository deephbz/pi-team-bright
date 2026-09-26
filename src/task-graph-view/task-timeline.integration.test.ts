import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GraphTaskController, type GraphTaskTransition } from "../task-authority/graph-control";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { graphTaskAuthorityPath } from "../utils/paths";
import { TaskGraphPaneComponent } from "./component";
import { layoutTaskTimeline, renderTaskTimelineViewport } from "./timeline";
import { parseTaskGraphViewSource, projectGraphControlTaskGraphViewSource } from "./source";

const epoch = Date.parse("2030-01-01T10:00:00.000Z");
const at = (minute: number) => new Date(epoch + minute * 60_000).toISOString();
function scenario() {
  let minute = 0;
  const controller = new GraphTaskController(undefined, () => new Date(at(minute)));
  controller.applyGraph({ operationId: "graph", tasks: [
    { key: "build", title: "Build", goal: "Pass.", assignee: "builder" },
    { key: "review", title: "Review", goal: "Pass.", assignee: "reviewer", needs: ["build"], onGoalFailed: { target: "build", maxTraversals: 2 } },
    { key: "verify", title: "Verify", goal: "Pass.", assignee: "verifier", needs: ["review"] },
    { key: "cancel", title: "Cancelled work", goal: "Pass.", assignee: "cancel-worker" },
  ] });
  const change = (taskId: string, transition: GraphTaskTransition, time: number) => {
    minute = time;
    const task = controller.readTask(taskId);
    controller.transition({ taskId, operationId: `${taskId}-${transition}-${time}`, expectedVersion: task.version,
      worker: task.assignee, transition, evidence: "Recorded result." });
  };
  change("build", "claim", 1);
  change("build", "block", 2);
  change("build", "resume", 5);
  change("build", "goal_achieved", 6);
  change("review", "claim", 7);
  change("review", "goal_failed", 8);
  change("build", "claim", 9);
  change("build", "goal_achieved", 10);
  change("review", "claim", 11);
  change("review", "block", 12);
  change("cancel", "claim", 13);
  change("cancel", "cancel", 14);
  return { controller, change };
}
function project(controller: GraphTaskController) {
  return projectGraphControlTaskGraphViewSource({ teamName: "timeline-test", trace: controller.trace() });
}
function pane(source = project(scenario().controller), rows = 32) {
  return new TaskGraphPaneComponent({ source, initialLimit: "all", terminalRows: () => rows,
    requestRender: () => undefined, now: () => Date.parse(at(15)), color: false });
}

describe("Task authority to timeline", () => {
  it("reads persisted authority and renders blocked spans, retries, cancellation, and dependency waiting without mutation", async () => {
    const { controller } = scenario();
    const before = controller.snapshot();
    const file = graphTaskAuthorityPath("timeline-test");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(before));
    try {
      const trace = await new DurableGraphTaskAuthority().trace("timeline-test");
      const source = projectGraphControlTaskGraphViewSource({ teamName: "timeline-test", trace });
      const build = source.nodes.find(node => node.id === "build")!;
      expect(build.timeline_attempts).toHaveLength(2);
      expect(build.timeline_attempts![0]).toMatchObject({ timing: "recorded", current: false, outcome: "goal_achieved", segments: [
        { state: "in_progress", started_at: at(1), ended_at: at(2) },
        { state: "blocked", started_at: at(2), ended_at: at(5) },
        { state: "in_progress", started_at: at(5), ended_at: at(6) },
      ] });
      expect(source.nodes.find(node => node.id === "review")!.timeline_attempts!.map(a => [a.ordinal, a.state]))
        .toEqual([[1, "completed"], [2, "blocked"]]);
      expect(source.nodes.find(node => node.id === "cancel")!.timeline_attempts![0].segments.at(-1)?.ended_at).toBe(at(14));
      const component = pane(source);
      expect(component.render(140).join("\n")).toContain("DAG");
      component.handleInput("v");
      const rendered = component.render(140).join("\n");
      expect(rendered).toContain("TIMELINE");
      expect(rendered).toContain("waiting for dependencies");
      expect(rendered).toContain("▒");
      expect(rendered).toContain("▶");
      expect(rendered).toContain("#2 blocked");
      expect(rendered).toContain("#1 cancelled");
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(before);
    } finally { fs.rmSync(file, { force: true }); }
  });

  it("keeps legacy or malformed timing unavailable without breaking Task recovery", () => {
    const snapshot = scenario().controller.snapshot();
    for (const event of snapshot.events) delete event.recorded_at;
    for (const revision of snapshot.graphRevisions) delete revision.recorded_at;
    snapshot.events[0].recorded_at = "not-a-time";
    const recovered = GraphTaskController.recover(snapshot);
    expect(project(recovered).nodes.flatMap(node => node.timeline_attempts ?? []).every(a => a.timing === "unavailable" && !a.segments.length)).toBe(true);
    const component = pane(project(recovered));
    component.handleInput("v");
    expect(component.render(120).join("\n")).toContain("timing unavailable");
  });

  it("detects clock rollback between Attempts and recovers timing after the prior high water", () => {
    const { controller } = scenario();
    const trace = controller.trace();
    // Review starts before its prerequisite completion on the wall clock.
    const start = trace.events.find(e => e.kind === "attempt_started" && e.taskId === "review")!;
    start.recorded_at = at(4);
    const source = projectGraphControlTaskGraphViewSource({ teamName: "clock-test", trace });
    const review = source.nodes.find(node => node.id === "review")!;
    expect(review.timeline_attempts![0]).toMatchObject({ timing: "unavailable", segments: [] });
    expect(review.timeline_attempts![1].timing).toBe("recorded");
  });

  it("excludes obsolete Task lineage and preserves old source transports with no timeline fields", () => {
    const { controller } = scenario();
    const tasks = controller.trace().graphRevisions.at(-1)!.tasks.map(task => ({ ...task, ...(task.key === "cancel" ? { goal: "Changed goal." } : {}) }));
    controller.applyGraph({ operationId: "revise", expectedGraphVersion: controller.currentGraphVersion(), tasks });
    const source = project(controller);
    expect(source.nodes.find(node => node.id === "cancel")!.timeline_attempts).toEqual([]);
    for (const node of source.nodes) delete node.timeline_attempts;
    expect(() => parseTaskGraphViewSource(source)).not.toThrow();
    const component = pane(source); component.handleInput("v");
    expect(component.render(120).join("\n")).toContain("no Attempt timing");
  });

  it("rejects fabricated discontinuous intervals in the human transport", () => {
    const source = project(scenario().controller);
    source.nodes.find(node => node.id === "build")!.timeline_attempts![0].segments[1].started_at = at(3);
    expect(() => parseTaskGraphViewSource(source)).toThrow(/discontinuous/);
  });
});

describe("Task timeline pane interaction", () => {
  it("preserves selection, details, and filters through the view switch; zoom and reset remain bounded", () => {
    const component = pane();
    component.render(160);
    component.handleInput("s"); // actionable
    component.handleInput("\t");
    component.handleInput("\r");
    const before = component.render(160);
    const detail = before.find(line => line.startsWith("Details:"));
    component.handleInput("v");
    let lines = component.render(160);
    expect(lines).toContain(detail);
    expect(lines[1]).toContain("actionable states");
    expect(lines[1]).toContain("SELECT · TIMELINE");
    component.handleInput("+");
    expect(component.render(160)[1]).toContain("zoom 2x");
    component.handleInput("\u001b[H");
    expect(component.render(160)[1]).toContain("zoom 1x");
    component.handleInput("v");
    expect(component.render(160)[1]).toContain("SELECT · DAG");
  });

  it("fits narrow terminals, marks clock-ahead open Attempts, and retains explicit unknown lanes", () => {
    const source = project(scenario().controller);
    for (const color of [true, false]) {
      const component = new TaskGraphPaneComponent({ source, initialLimit: "all", terminalRows: () => 30,
        requestRender: () => undefined, now: () => Date.parse(at(15)), color });
      component.handleInput("v");
      for (const width of [1, 8, 24, 48, 80, 120]) {
        expect(component.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
        expect(component.render(width).at(-2)).not.toContain("\u001b[7m");
      }
    }
    const layout = layoutTaskTimeline(source, "all", "all", 140, Date.parse(at(10)));
    const text = renderTaskTimelineViewport({ layout, x: 0, y: 0, height: 30, now: Date.parse(at(10)), color: false }).join("\n");
    expect(text).toContain("clock ahead");
  });

  it("keeps large Task sets scrollable with the same bounded filter membership", () => {
    const controller = new GraphTaskController(undefined, () => new Date(at(0)));
    controller.applyGraph({ operationId: "large", tasks: Array.from({ length: 240 }, (_, i) => ({
      key: `task-${String(i).padStart(3, "0")}`, title: `Task ${i}`, goal: "Pass.", assignee: `worker-${i}`,
    })) });
    const component = pane(project(controller), 24);
    component.handleInput("v");
    expect(component.render(160)[1]).toContain("240/240 tasks");
    for (let i = 0; i < 150; i++) component.handleInput("j");
    const lines = component.render(160);
    expect(lines.join("\n")).toContain("task-239");
    expect(lines).toHaveLength(24);
    expect(lines.every(line => visibleWidth(line) <= 160)).toBe(true);
    component.handleInput("f");
    expect(component.render(160)[1]).toContain("25/240 tasks");
  });
});
