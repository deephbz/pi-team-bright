import { expect, it, vi } from "vitest";
import { HerdrAdapter } from "./herdr-adapter";
import { nodeHostEnv, runWithHostEnv, type ExecOutcome, type HostEnv } from "../env/host-env";
import type { SpawnOptions } from "../utils/terminal-adapter";

const reply = (result: unknown): ExecOutcome => ({ kind: "exited", status: 0, stderr: "", stdout: JSON.stringify({ result }) });
const missing = (): ExecOutcome => ({ kind: "exited", status: 1, stdout: "", stderr: JSON.stringify({ error: { code: "pane_not_found", message: "closed" } }) });
const options = (workers: string[]): SpawnOptions => ({ name: "worker", cwd: "/repo", argv: ["pi"], env: {}, panePlacement: { leaderPaneId: "leader", workerPaneIds: workers, paneLayout: { worker_tiling: "linear", leader_share: 0.6 } } });
function fixture(workers: string[]) {
  const layout = { tab_id: "tab", workspace_id: "workspace", panes: [
    { pane_id: "leader", rect: { x: 0, y: 0, width: 120, height: 60 } },
    ...workers.map((pane_id, index) => ({ pane_id, rect: { x: 120, y: index * 10, width: 80, height: 10 } })),
  ] };
  const run = vi.fn(async (_command: string, args: readonly string[]): Promise<ExecOutcome> => {
    if (args[1] === "layout") return reply({ layout });
    if (args[1] === "get") {
      const pane = layout.panes.find(pane => pane.pane_id === args[2]);
      return pane ? reply({ pane: { ...pane, tab_id: layout.tab_id, workspace_id: layout.workspace_id } }) : missing();
    }
    if (args[1] === "split") return reply({ pane: { pane_id: "new-worker" } });
    if (args[1] === "rename") return reply({ type: "ok" });
    throw new Error(`Unexpected command ${args.join(" ")}`);
  });
  const host: HostEnv = { ...nodeHostEnv, exec: { run, runSync: () => { throw new Error("Unexpected synchronous exec"); } } };
  return { layout, run, host };
}

it.each([0, 9])("uses one exact layout observation to place a Worker among %s registered panes", async count => {
  const workers = Array.from({ length: count }, (_, index) => `worker-${index}`);
  const { run, host } = fixture(workers);
  await runWithHostEnv(host, async () => {
    expect(await new HerdrAdapter().prepareSpawnAsync(options(workers))).toBe("new-worker");
  });
  expect(run.mock.calls.map(([, args]) => args.slice(0, 2).join(" "))).toEqual(["pane layout", "pane split", "pane rename"]);
  expect(run.mock.calls[1][1]).toContain(count ? "worker-8" : "leader");
});

it("queries a registered pane missing from layout and accepts only explicit absence", async () => {
  const { run, host } = fixture([]);
  await runWithHostEnv(host, async () => {
    expect(await new HerdrAdapter().prepareSpawnAsync(options(["closed-worker"]))).toBe("new-worker");
  });
  expect(run.mock.calls.map(([, args]) => args.slice(0, 2).join(" "))).toEqual(["pane layout", "pane get", "pane split", "pane rename"]);
  expect(run.mock.calls[1][1]).toEqual(["pane", "get", "closed-worker"]);
  expect(run.mock.calls[2][1]).toContain("leader");
});

it.each(["timeout", "moved"])("does not infer absence for a %s registered pane missing from layout", async state => {
  const { run, host } = fixture([]);
  const normal = run.getMockImplementation()!;
  run.mockImplementation(async (command, args) => args[1] !== "get" || args[2] !== "other-worker" ? normal(command, args)
    : state === "timeout" ? { kind: "timeout", afterMs: 2000 }
    : reply({ pane: { pane_id: "other-worker", tab_id: "elsewhere", workspace_id: "workspace" } }));
  await runWithHostEnv(host, async () => {
    await expect(new HerdrAdapter().prepareSpawnAsync(options(["other-worker"]))).rejects.toThrow(state === "timeout" ? "timeout" : "not in the leader tab");
  });
  expect(run.mock.calls.some(([, args]) => args[1] === "split")).toBe(false);
});

it.each(["missing-leader", "missing-tab", "duplicate-pane"])("refuses a malformed layout (%s) before any mutation", async fault => {
  const { layout, run, host } = fixture([]);
  if (fault === "missing-leader") layout.panes[0].pane_id = "wrong-leader";
  if (fault === "missing-tab") layout.tab_id = "";
  if (fault === "duplicate-pane") layout.panes.push({ ...layout.panes[0] });
  await runWithHostEnv(host, async () => {
    await expect(new HerdrAdapter().prepareSpawnAsync(options([]))).rejects.toThrow();
  });
  expect(run.mock.calls.some(([, args]) => args[1] === "split")).toBe(false);
});

it("takes a fresh layout on the next placement operation", async () => {
  const { layout, run, host } = fixture([]);
  await runWithHostEnv(host, async () => {
    const adapter = new HerdrAdapter();
    await adapter.prepareSpawnAsync(options([]));
    layout.panes[0].rect.width = 121;
    await adapter.prepareSpawnAsync(options([]));
  });
  expect(run.mock.calls.filter(([, args]) => args[1] === "layout")).toHaveLength(2);
  const splits = run.mock.calls.filter(([, args]) => args[1] === "split");
  expect(splits[0][1]).toContain("0.6");
  expect(splits[1][1]).toContain(String(73 / 121));
});
