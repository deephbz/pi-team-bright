import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphTaskController } from "../task-authority/graph-control";
import type { BeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";
import type { TaskGraphPaneHost } from "./herdr-pane";
import { TaskGraphPaneService, type TaskGraphControlReadSource } from "./integration";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

class Host implements TaskGraphPaneHost {
  readonly panes = new Map([
    ["origin", { paneId: "origin", tabId: "tab", workspaceId: "workspace" }],
  ]);
  sourcePath?: string;

  getPane(id: string) { return this.panes.get(id); }
  splitRight() {
    this.panes.set("graph", { paneId: "graph", tabId: "tab", workspaceId: "workspace" });
    return "graph";
  }
  run(_paneId: string, command: string) { this.sourcePath = /--source '([^']+)'/.exec(command)?.[1]; }
  rename() {}
  close(id: string) { this.panes.delete(id); }
}

function graphTrace() {
  const controller = new GraphTaskController({ default: "provider/default", capable: "provider/capable" });
  controller.applyGraph({ operationId: "graph", tasks: [
    { key: "graph-task", title: "Graph Task", goal: "Pass.", assignee: "worker" },
  ] });
  return controller.trace();
}

describe("Task graph pane authority refresh", () => {
  it("reads graph authority before Beads and watches its exact snapshot coordinate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-service-"));
    directories.push(root);
    const authorityPath = path.join(root, "task-authority", "graph-control.json");
    fs.mkdirSync(path.dirname(authorityPath), { recursive: true });
    fs.writeFileSync(authorityPath, "{}\n");
    const graphSource: TaskGraphControlReadSource = {
      hasGraph: vi.fn(() => true),
      trace: vi.fn(async () => graphTrace()),
      watchPath: vi.fn(() => authorityPath),
    };
    const listCurrentTasks = vi.fn(async () => []);
    const taskReadAdapterFactory = (() => ({ listCurrentTasks })) as unknown as BeadsTaskAdapterFactory;
    const host = new Host();
    const prior = {
      HERDR_ENV: process.env.HERDR_ENV,
      HERDR_PANE_ID: process.env.HERDR_PANE_ID,
      HERDR_TAB_ID: process.env.HERDR_TAB_ID,
      HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
    };
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "origin",
      HERDR_TAB_ID: "tab",
      HERDR_WORKSPACE_ID: "workspace",
    });
    const service = new TaskGraphPaneService({ taskReadAdapterFactory, graphControlSource: graphSource, host: host as never });
    try {
      await service.toggle({ teamName: "team", actor: "team-lead", cwd: root, limitText: "25" });
      const source = JSON.parse(fs.readFileSync(host.sourcePath!, "utf8"));
      expect(source).toMatchObject({ authority: "graph_control", graph_version: expect.stringMatching(/^g_/) });
      expect(graphSource.trace).toHaveBeenCalledWith("team");
      expect(graphSource.watchPath).toHaveBeenCalledWith("team");
      expect(listCurrentTasks).not.toHaveBeenCalled();
    } finally {
      service.shutdown();
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("watches a missing authority through an existing ancestor without creating authority storage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-read-only-"));
    directories.push(root);
    const authorityDirectory = path.join(root, "missing", "task-authority");
    const authorityPath = path.join(authorityDirectory, "graph-control.json");
    const graphSource: TaskGraphControlReadSource = {
      hasGraph: vi.fn(() => false),
      trace: vi.fn(async () => graphTrace()),
      watchPath: vi.fn(() => authorityPath),
    };
    const taskReadAdapterFactory = (() => ({ listCurrentTasks: async () => [] })) as unknown as BeadsTaskAdapterFactory;
    const host = new Host();
    const prior = {
      HERDR_ENV: process.env.HERDR_ENV,
      HERDR_PANE_ID: process.env.HERDR_PANE_ID,
      HERDR_TAB_ID: process.env.HERDR_TAB_ID,
      HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
    };
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "origin",
      HERDR_TAB_ID: "tab",
      HERDR_WORKSPACE_ID: "workspace",
    });
    const service = new TaskGraphPaneService({ taskReadAdapterFactory, graphControlSource: graphSource, host: host as never });
    try {
      await service.toggle({ teamName: "team", actor: "team-lead", cwd: root });
      expect(fs.existsSync(authorityDirectory)).toBe(false);
      expect(graphSource.trace).not.toHaveBeenCalled();
    } finally {
      service.shutdown();
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
