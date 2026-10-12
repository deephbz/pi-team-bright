import { describe, expect, it } from "vitest";
import { HerdrFake, ExecRouter } from "./herdr";
import { ProcessTable } from "./process-table";

describe("Herdr wire fake", () => {
  it("keeps a shell after Pi exit and never revives an agent name on pid reuse", () => {
    const processes = new ProcessTable();
    const herdr = new HerdrFake(processes);
    const pane = herdr.spawn("pane-1");
    expect(herdr.list()).toEqual([]);
    herdr.start(pane.id, "worker");
    const oldPid = pane.agentPid!;
    expect(herdr.list()).toHaveLength(1);
    processes.kill(oldPid);
    processes.reuse("worker", "unrelated");
    expect(herdr.list()).toEqual([]);
    expect(processes.exists(pane.shellPid)).toBe(true);
    herdr.close(pane.id);
    expect(processes.exists(oldPid)).toBe(true);
    expect(herdr.evidence.map(e => e.assumption)).toContain("A2");
  });

  it("distinguishes disappeared panes, a partial list, and service loss", () => {
    const herdr = new HerdrFake(new ProcessTable());
    const router = new ExecRouter(herdr);
    expect(router.runSync("herdr", ["agent", "start", "worker", "--pane", "absent"]).status).toBe(1);
    herdr.spawn("pane-1"); herdr.start("pane-1", "worker");
    herdr.partialList = new Set();
    expect(JSON.parse(router.runSync("herdr", ["agent", "list"]).stdout).result.agents).toEqual([]);
    expect(herdr.agentLive(herdr.panes.get("pane-1")!)).toBe(true);
    herdr.available = false;
    expect(router.runSync("herdr", ["agent", "list"]).status).toBe(1);
    expect(() => router.runSync("curl", [])).toThrow("Unmodeled exec");
    herdr.available = true;
    expect(() => router.runSync("herdr", ["server", "stop"])).toThrow("Unmodeled Herdr");
  });

  it("exposes shell process-info before managed start and Pi child afterwards", () => {
    const herdr = new HerdrFake(new ProcessTable());
    herdr.spawn("pane-1");
    const info = () => JSON.parse(herdr.run(["pane", "process-info", "pane-1"]).stdout).result.process_info;
    expect(info().foreground_processes.map((p: any) => p.argv0)).toEqual(["zsh"]);
    herdr.start("pane-1", "worker");
    expect(info().foreground_processes.map((p: any) => p.argv0)).toEqual(["pi"]);
  });
});
