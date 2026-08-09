import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlledProcess,
  FakeTerminalAdapter,
  assertCursorAdvanced,
  assertCursorUnchanged,
  captureTrioProjection,
  createIsolatedWorkspace,
  trioProjectionDifferences,
  type IsolatedWorkspace,
  type RegisteredToolLike,
} from "./external-harness";

const workspaces: IsolatedWorkspace[] = [];
const processes: ControlledProcess[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) {
    if (process.running) await process.crash();
  }
  for (const workspace of workspaces.splice(0)) workspace.cleanup();
});

function workspace(): IsolatedWorkspace {
  const created = createIsolatedWorkspace();
  workspaces.push(created);
  return created;
}

describe("external behavior harness", () => {
  it("isolates child filesystem state and removes inherited Team bindings", async () => {
    const fixture = workspace();
    const script = fixture.write("probe.mjs", [
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      "const target = path.join(os.homedir(), 'probe.txt');",
      "fs.writeFileSync(target, 'isolated');",
      "console.log(JSON.stringify({ home: os.homedir(), tmp: os.tmpdir(), team: process.env.PI_TEAM_NAME, target }));",
    ].join("\n"));
    const environment = fixture.childEnvironment();
    const child = new ControlledProcess({
      command: process.execPath,
      args: [script],
      cwd: fixture.root,
      env: environment,
    }).start();
    processes.push(child);

    await child.waitForOutput("target");
    const exit = await child.waitForExit();
    const observation = JSON.parse(exit.stdout.trim());
    expect(exit.code).toBe(0);
    expect(observation).toEqual({
      home: fixture.home,
      tmp: fixture.tmp,
      target: path.join(fixture.home, "probe.txt"),
    });
    expect(fs.readFileSync(observation.target, "utf8")).toBe("isolated");
    expect(fixture.childEnvironment({ PI_TEAM_NAME: "explicit-fixture-team" }).PI_TEAM_NAME).toBe("explicit-fixture-team");
  });

  it("injects a real process crash and restarts the same controlled command", async () => {
    const fixture = workspace();
    const script = fixture.write("long-running.mjs", [
      "console.log(`ready:${process.pid}`);",
      "setInterval(() => {}, 1_000);",
    ].join("\n"));
    const child = new ControlledProcess({
      command: process.execPath,
      args: [script],
      cwd: fixture.root,
      env: fixture.childEnvironment(),
      timeoutMs: 2_000,
    }).start();
    processes.push(child);

    await child.waitForOutput("ready:");
    const firstPid = child.pid;
    const crashed = await child.crash();
    expect(crashed.signal).toBe("SIGKILL");

    await child.restart();
    await child.waitForOutput("ready:");
    expect(child.pid).not.toBe(firstPid);
    expect(child.running).toBe(true);
  });

  it("records terminal requests and distinguishes carrier death from requested stop", () => {
    const terminal = new FakeTerminalAdapter();
    const pane = terminal.spawn({
      name: "worker",
      cwd: "/fixture",
      argv: ["pi", "--session", "fixture"],
      env: { PI_TEAM_NAME: "fixture-team" },
    });
    expect(terminal.isAlive(pane)).toBe(true);
    terminal.crashPane(pane);
    expect(terminal.isAlive(pane)).toBe(false);
    expect(terminal.operations.map((operation) => operation.kind)).toEqual(["spawn"]);

    const replacement = terminal.spawn({ name: "worker", cwd: "/fixture", argv: ["pi"], env: {} });
    terminal.kill(replacement);
    expect(terminal.operations.map((operation) => operation.kind)).toEqual(["spawn", "spawn", "kill"]);
  });

  it("asserts event-cursor no-advance and monotonic-advance outcomes", () => {
    expect(() => assertCursorUnchanged("7", "7")).not.toThrow();
    expect(() => assertCursorAdvanced("7", "8")).not.toThrow();
    expect(() => assertCursorUnchanged("7", "8")).toThrow(/remain unchanged/);
    expect(() => assertCursorAdvanced("7", "7")).toThrow(/advance beyond/);
    expect(() => assertCursorAdvanced("7", "6")).toThrow(/advance beyond/);
    expect(() => assertCursorAdvanced("bad", "8")).toThrow(/Invalid event cursor/);
  });

  it("captures and compares machine, model, and human projections without changing thrown errors", async () => {
    const tool: RegisteredToolLike = {
      name: "fixture_tool",
      async execute() {
        return {
          content: [{ type: "text", text: "model:accepted" }],
          details: { kind: "accepted", version: "v_1" },
        };
      },
      renderResult(result, options) {
        return { render: (width) => [`human:${options.expanded ? "expanded" : "collapsed"}:${width}:${(result.details as any).kind}`] };
      },
    };

    const baseline = await captureTrioProjection({ tool, args: {}, width: 80 });
    const same = await captureTrioProjection({ tool, args: {}, width: 80 });
    expect(baseline).toMatchObject({
      execution: { kind: "returned", isError: false },
      machine: { details: { kind: "accepted", version: "v_1" } },
      model: { text: "model:accepted" },
      human: {
        collapsed: "human:collapsed:80:accepted",
        expanded: "human:expanded:80:accepted",
      },
    });
    expect(trioProjectionDifferences(baseline, same)).toEqual([]);

    const changed = structuredClone(same);
    changed.human!.expanded = "different";
    expect(trioProjectionDifferences(baseline, changed)).toEqual(["human"]);

    const thrown = await captureTrioProjection({
      tool: { name: "throws", async execute() { throw new Error("source failure"); } },
      args: {},
    });
    expect(thrown).toEqual({ tool: "throws", execution: { kind: "threw", error: "source failure" } });
  });
});
