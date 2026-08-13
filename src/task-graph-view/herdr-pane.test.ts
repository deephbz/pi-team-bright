import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { TaskCard } from "../task-authority/task-domain";
import { taskVersionRef } from "../task-authority/task-version-ref";
import { HerdrCliTaskGraphPaneHost, TaskGraphPaneController, type HerdrPaneCoordinate, type TaskGraphPaneHost, type TaskGraphPaneOrigin } from "./herdr-pane";
import { projectTaskGraphViewSource } from "./source";

class Host implements TaskGraphPaneHost {
  readonly calls: Array<{ name: string; args: unknown[] }> = [];
  readonly panes = new Map<string, HerdrPaneCoordinate>();
  failRun = false;

  getPane(paneId: string) { this.calls.push({ name: "get", args: [paneId] }); return this.panes.get(paneId); }
  splitRight(originPaneId: string, cwd: string) {
    this.calls.push({ name: "split", args: [originPaneId, cwd, "--no-focus"] });
    const origin = this.panes.get(originPaneId)!;
    this.panes.set("pane-graph", { ...origin, paneId: "pane-graph" });
    return "pane-graph";
  }
  run(paneId: string, command: string) {
    this.calls.push({ name: "run", args: [paneId, command] });
    if (this.failRun) throw new Error("run failed");
  }
  rename(paneId: string, label: string) { this.calls.push({ name: "rename", args: [paneId, label] }); }
  close(paneId: string) { this.calls.push({ name: "close", args: [paneId] }); this.panes.delete(paneId); }
}

function graph() {
  const card: TaskCard = {
    id: "task-a", title: "Task A", goal: "Goal", current_context: "Current", status: "open",
    relations: [], dependency_state: { kind: "ready", active_blocker_ids: [] }, version: taskVersionRef("a"),
  };
  return projectTaskGraphViewSource({ teamName: "team-a", tasks: [card], activity: { headCursor: "1", tasks: [{ taskId: card.id, cursor: "1" }] } });
}

function setup() {
  const host = new Host();
  const origin: TaskGraphPaneOrigin = { paneId: "pane-origin", tabId: "tab-a", workspaceId: "workspace-a", cwd: "/repo" };
  host.panes.set(origin.paneId, origin);
  const controller = new TaskGraphPaneController(host, "/package/src/cli/task-graph-pane.ts", "/runtime/node");
  return { host, origin, controller };
}

describe("Task graph Herdr pane lifecycle", () => {
  it("accepts Herdr pane run's successful empty stdout", () => {
    const execute = vi.fn(() => ({ stdout: "", stderr: "", status: 0 }));
    const host = new HerdrCliTaskGraphPaneHost("herdr-test", execute);
    expect(() => host.run("pane-graph", "node graph.js")).not.toThrow();
    expect(execute).toHaveBeenCalledWith("herdr-test", ["pane", "run", "pane-graph", "node graph.js"]);
  });

  it("reports a failed Herdr pane run without parsing an envelope", () => {
    const host = new HerdrCliTaskGraphPaneHost("herdr-test", () => ({
      stdout: "",
      stderr: "run refused",
      status: 1,
    }));
    expect(() => host.run("pane-graph", "node graph.js")).toThrow(/run refused/);
  });

  it("opens in the exact origin with no-focus and toggles only the owned pane closed", () => {
    const { host, origin, controller } = setup();
    expect(controller.toggle({ origin, source: graph(), limit: 50 })).toEqual({ kind: "opened", paneId: "pane-graph" });
    expect(host.calls.find((call) => call.name === "split")?.args).toEqual(["pane-origin", "/repo", "--no-focus"]);
    const command = host.calls.find((call) => call.name === "run")?.args[1] as string;
    expect(command).toContain("env 'TS_NODE_PROJECT=/package/tsconfig.json' '/runtime/node' --require");
    expect(command).toContain("--source");
    expect(command).not.toContain("Task A");
    expect(controller.toggle({ origin, source: graph() })).toEqual({ kind: "closed", paneId: "pane-graph" });
    expect(host.calls.filter((call) => call.name === "close").map((call) => call.args[0])).toEqual(["pane-graph"]);
  });

  it("refuses to close a moved pane and keeps ownership for a later safe action", () => {
    const { host, origin, controller } = setup();
    controller.toggle({ origin, source: graph() });
    host.panes.set("pane-graph", { paneId: "pane-graph", tabId: "tab-b", workspaceId: "workspace-a" });
    expect(() => controller.close()).toThrow(/moved outside/i);
    expect(controller.isOpen).toBe(true);
    expect(host.calls.filter((call) => call.name === "close")).toHaveLength(0);
  });

  it("forgets a pane that disappeared outside the command without closing another target", () => {
    const { host, origin, controller } = setup();
    controller.toggle({ origin, source: graph() });
    host.panes.delete("pane-graph");
    expect(controller.forgetMissing()).toBe(true);
    expect(controller.isOpen).toBe(false);
    expect(host.calls.filter((call) => call.name === "close")).toHaveLength(0);
  });

  it("compensates a partial open and removes its private source", () => {
    const { host, origin, controller } = setup();
    host.failRun = true;
    let privateSource = "";
    const originalRun = host.run.bind(host);
    host.run = (paneId, command) => {
      privateSource = /--source '([^']+)'/.exec(command)?.[1] ?? "";
      originalRun(paneId, command);
    };
    expect(() => controller.toggle({ origin, source: graph() })).toThrow(/run failed/);
    expect(host.panes.has("pane-graph")).toBe(false);
    expect(controller.isOpen).toBe(false);
    expect(privateSource).not.toBe("");
    expect(fs.existsSync(privateSource)).toBe(false);
  });

  it("shutdown closes only a same-tab pane and always removes process ownership", () => {
    const { host, origin, controller } = setup();
    controller.toggle({ origin, source: graph() });
    controller.shutdown();
    expect(host.panes.has("pane-graph")).toBe(false);
    expect(controller.isOpen).toBe(false);
  });
});
