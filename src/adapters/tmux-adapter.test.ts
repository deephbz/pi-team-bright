/**
 * Tmux Adapter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TmuxAdapter } from "./tmux-adapter";
import * as terminalAdapter from "../utils/terminal-adapter";

describe("TmuxAdapter", () => {
  let adapter: TmuxAdapter;
  let mockExecCommand: ReturnType<typeof vi.spyOn>;
  const originalTmux = process.env.TMUX;
  const originalTmuxPane = process.env.TMUX_PANE;

  beforeEach(() => {
    adapter = new TmuxAdapter();
    mockExecCommand = vi.spyOn(terminalAdapter, "execCommand");
    process.env.TMUX = "/tmp/tmux-1000/default,123,0";
    process.env.TMUX_PANE = "%16";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = originalTmuxPane;
  });

  it("has the correct name", () => {
    expect(adapter.name).toBe("tmux");
  });

  it("detects tmux when TMUX is set", () => {
    expect(adapter.detect()).toBe(true);
  });

  it("splits the exact leader right and preserves its 60% width", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "display-message") return { stdout: "@7\t0\t60", stderr: "", status: 0 };
      if (args[0] === "split-window") return { stdout: "%worker-1", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 0 };
    });

    expect(adapter.spawn({
      name: "worker-1",
      cwd: "/tmp/project",
      command: "pi",
      env: { PI_TEAM_NAME: "team-1", PI_AGENT_NAME: "worker-1", OTHER: "ignored" },
      panePlacement: { leaderPaneId: "%leader", workerPaneIds: [] },
    })).toBe("%worker-1");

    expect(mockExecCommand).toHaveBeenCalledWith("tmux", [
      "split-window", "-h", "-l", "40%", "-dP", "-F", "#{pane_id}", "-t", "%leader",
      "-c", "/tmp/project", "env", "PI_TEAM_NAME=team-1", "PI_AGENT_NAME=worker-1", "sh", "-c", "pi",
    ]);
    expect(mockExecCommand).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["select-layout"]));
  });

  it("floors a non-default Worker percentage to preserve the leader share", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "display-message") return { stdout: "@7\t0\t60", stderr: "", status: 0 };
      if (args[0] === "split-window") return { stdout: "%worker-1", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 0 };
    });

    expect(adapter.spawn({
      name: "worker-1", cwd: "/tmp/project", command: "pi", env: {},
      panePlacement: { leaderPaneId: "%leader", workerPaneIds: [], paneLayout: { leader_share: 0.655, worker_tiling: "linear" } },
    })).toBe("%worker-1");
    expect(mockExecCommand).toHaveBeenCalledWith("tmux", expect.arrayContaining(["-l", "34%"]));
  });

  it("splits the exact current Worker downward", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "display-message" && args[3] === "%worker-1") return { stdout: "@7\t60\t40", stderr: "", status: 0 };
      if (args[0] === "display-message" && args[3] === "%leader") return { stdout: "@7\t0\t60", stderr: "", status: 0 };
      if (args[0] === "split-window") return { stdout: "%worker-2", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 0 };
    });

    expect(adapter.spawn({
      name: "worker-2",
      cwd: "/tmp/project",
      command: "pi",
      env: { PI_TEAM_NAME: "team-1", PI_AGENT_NAME: "worker-2" },
      panePlacement: { leaderPaneId: "%leader", workerPaneIds: ["%worker-1"] },
    })).toBe("%worker-2");

    expect(mockExecCommand).toHaveBeenCalledWith("tmux", [
      "split-window", "-v", "-dP", "-F", "#{pane_id}", "-t", "%worker-1",
      "-c", "/tmp/project", "env", "PI_TEAM_NAME=team-1", "PI_AGENT_NAME=worker-2", "sh", "-c", "pi",
    ]);
    expect(mockExecCommand).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["select-layout"]));
  });

  it("refuses a stale exact Team target instead of using the current pane", () => {
    mockExecCommand.mockReturnValue({ stdout: "", stderr: "no such pane", status: 1 });

    expect(() => adapter.spawn({
      name: "worker-2",
      cwd: "/tmp/project",
      command: "pi",
      env: { PI_TEAM_NAME: "team-1", PI_AGENT_NAME: "worker-2" },
      panePlacement: { leaderPaneId: "%leader", workerPaneIds: ["%stale"] },
    })).toThrow(/unavailable.*ambient/i);
    expect(mockExecCommand).toHaveBeenCalledWith("tmux", ["display-message", "-p", "-t", "%stale", "#{window_id}\t#{pane_left}\t#{pane_width}"]);
    expect(mockExecCommand).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["split-window"]));
  });

  it("refuses a valid Worker pane moved outside the leader Worker region", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "display-message" && args[3] === "%worker-moved") return { stdout: "@8\t0\t40", stderr: "", status: 0 };
      if (args[0] === "display-message" && args[3] === "%leader") return { stdout: "@7\t0\t60", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 0 };
    });

    expect(() => adapter.spawn({
      name: "worker-2",
      cwd: "/tmp/project",
      command: "pi",
      env: { PI_TEAM_NAME: "team-1", PI_AGENT_NAME: "worker-2" },
      panePlacement: { leaderPaneId: "%leader", workerPaneIds: ["%worker-moved"] },
    })).toThrow(/outside the leader Worker region/i);
    expect(mockExecCommand).not.toHaveBeenCalledWith("tmux", expect.arrayContaining(["split-window"]));
  });

  it("targets the current pane when setting the title", () => {
    mockExecCommand.mockReturnValue({ stdout: "", stderr: "", status: 0 });
    adapter.setTitle("team: worker-1");
    expect(mockExecCommand).toHaveBeenCalledWith("tmux", ["select-pane", "-t", "%16", "-T", "team: worker-1"]);
  });
});
