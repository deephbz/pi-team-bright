import { afterEach, expect, it, vi } from "vitest";
import { getAdapterByName } from "./terminal-registry";
import { TmuxAdapter } from "./tmux-adapter";
import { ZellijAdapter } from "./zellij-adapter";
import { CmuxAdapter } from "./cmux-adapter";
import { Iterm2Adapter } from "./iterm2-adapter";
import { WezTermAdapter } from "./wezterm-adapter";
import { WindowsAdapter } from "./windows-adapter";
import type { SpawnOptions, SynchronousTerminalAdapter } from "../utils/terminal-adapter";

const backends: Array<[string, SynchronousTerminalAdapter]> = [
  ["tmux", TmuxAdapter.prototype], ["zellij", ZellijAdapter.prototype], ["cmux", CmuxAdapter.prototype],
  ["iTerm2", Iterm2Adapter.prototype], ["WezTerm", WezTermAdapter.prototype], ["Windows", WindowsAdapter.prototype],
];
const options: SpawnOptions = { name: "worker", cwd: "/fixture", argv: ["pi"], env: {},
  panePlacement: { leaderPaneId: "leader", workerPaneIds: ["iterm_previous"] } };
afterEach(() => vi.restoreAllMocks());

it.each(backends)("preserves %s one-stage pane and window spawn ordering inside the registry", async (name, prototype) => {
  const order: string[] = [];
  const spawn = vi.spyOn(prototype, "spawn").mockImplementation(() => { order.push("process_start"); return "exact-pane"; });
  const spawnWindow = vi.spyOn(prototype, "spawnWindow").mockImplementation(() => { order.push("window_process_start"); return "exact-window"; });
  const terminal = getAdapterByName(name)!;
  const pane = await terminal.prepareSpawn(options);
  order.push("target_cas");
  await expect(terminal.startPrepared(pane, options)).resolves.toEqual({ state: "started", fact: "carrier_start_accepted" });
  expect(order).toEqual(["process_start", "target_cas"]);
  expect(spawn).toHaveBeenCalledExactlyOnceWith(options);
  const window = await terminal.prepareWindow(options);
  order.push("window_target_cas");
  await terminal.startPrepared(window, options);
  expect(order).toEqual(["process_start", "target_cas", "window_process_start", "window_target_cas"]);
  expect(spawnWindow).toHaveBeenCalledExactlyOnceWith(options);
  expect(spawn).toHaveBeenCalledOnce();
});

it("sets and clears iTerm placement context within the registry before one-stage spawn", async () => {
  const context = vi.spyOn(Iterm2Adapter.prototype, "setSpawnContext");
  vi.spyOn(Iterm2Adapter.prototype, "spawn").mockImplementation(() => {
    expect(context).toHaveBeenCalled(); return "pane";
  });
  const terminal = getAdapterByName("iTerm2")!;
  await terminal.prepareSpawn(options);
  expect(context).toHaveBeenLastCalledWith({ lastSessionId: "previous" });
  await terminal.prepareSpawn({ ...options, panePlacement: { leaderPaneId: "leader", workerPaneIds: [] } });
  expect(context).toHaveBeenLastCalledWith({});
});
