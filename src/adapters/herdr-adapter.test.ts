import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerdrAdapter } from "./herdr-adapter";
import * as terminalAdapter from "../utils/terminal-adapter";

const success = (result: unknown) => ({
  stdout: JSON.stringify({ id: "cli:test", result }), stderr: "", status: 0,
});

const failure = (code: string, message: string, status = 1) => ({
  stdout: JSON.stringify({ id: "cli:test", error: { code, message } }), stderr: message, status,
});

const leaderLayout = (paneId: string, width = 82) => success({ type: "pane_layout", layout: {
  panes: [{ pane_id: paneId, rect: { width } }],
} });

describe("HerdrAdapter", () => {
  let adapter: HerdrAdapter;
  let exec: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = new HerdrAdapter();
    exec = vi.spyOn(terminalAdapter, "execCommand");
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_TAB_ID", "tab-origin");
    vi.stubEnv("HERDR_PANE_ID", "pane-origin");
    vi.stubEnv("TMUX", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("detects only a usable Herdr pane/tab environment and wins while nested in tmux", () => {
    exec.mockReturnValue({ stdout: "status: running", stderr: "", status: 0 });
    expect(adapter.detect()).toBe(true);
    expect(exec).toHaveBeenCalledWith("herdr", ["status", "server"]);
    vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
    expect(adapter.detect()).toBe(true);

    exec.mockReturnValue({ stdout: "", stderr: "not running", status: 1 });
    expect(adapter.detect()).toBe(false);
    exec.mockReturnValue({ stdout: "status: running", stderr: "", status: 0 });
    vi.stubEnv("HERDR_TAB_ID", "");
    expect(adapter.detect()).toBe(false);
    vi.stubEnv("HERDR_TAB_ID", "tab-origin");
    vi.stubEnv("HERDR_PANE_ID", "");
    expect(adapter.detect()).toBe(false);
    vi.stubEnv("HERDR_PANE_ID", "pane-origin");
    vi.stubEnv("HERDR_ENV", "0");
    expect(adapter.detect()).toBe(false);
  });

  it("distinguishes a visible Herdr surface from a direct Herdr carrier", () => {
    expect(adapter.isDirectCarrier()).toBe(true);
    vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
    expect(adapter.isDirectCarrier()).toBe(false);
    vi.stubEnv("TMUX", "");
    vi.stubEnv("TMUX_PANE", "%nested");
    expect(adapter.isDirectCarrier()).toBe(false);
  });

  it("splits a direct Herdr pane then starts Pi there with structured argv and allowlisted environment", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(success({ type: "agent_info", agent: { pane_id: "pane-worker" } }));

    expect(adapter.spawn({
      name: "worker",
      cwd: "/repo with spaces",
      argv: ["pi", "--model", "openai/model;not-a-shell", "--tools", "task_read,task_update"],
      env: {
        PI_TEAM_NAME: "team-a",
        PI_AGENT_NAME: "worker",
        HTTPS_PROXY: "http://127.0.0.1:6152",
        OTHER: "must-not-pass",
      },
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    })).toBe("pane-worker");

    expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["pane", "get", "pane-origin"]);
    expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "layout", "--pane", "pane-origin"]);
    expect(exec).toHaveBeenNthCalledWith(3, "herdr", [
      "pane", "split", "--pane", "pane-origin", "--direction", "right", "--ratio", "0.6097560975609756",
      "--cwd", "/repo with spaces",
      "--env", "PI_TEAM_NAME=team-a",
      "--env", "PI_AGENT_NAME=worker",
      "--env", "HTTPS_PROXY=http://127.0.0.1:6152",
      "--no-focus",
    ]);
    expect(exec).toHaveBeenNthCalledWith(4, "herdr", [
      "agent", "start", "worker",
      "--kind", "pi",
      "--pane", "pane-worker",
      "--",
      "--model", "openai/model;not-a-shell", "--tools", "task_read,task_update",
    ]);
  });

  it("splits an exact current Worker downward without changing the leader", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "w4" } }))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker-1", tab_id: "tab-a", workspace_id: "w4" } }))
      .mockReturnValueOnce(success({ type: "pane_layout", layout: {
        tab_id: "tab-a", workspace_id: "w4",
        panes: [
          { pane_id: "pane-leader", rect: { x: 0, width: 60 } },
          { pane_id: "pane-worker-1", rect: { x: 60, width: 40 } },
        ],
      } }))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker-2" } }))
      .mockReturnValueOnce(success({ type: "agent_info", agent: { pane_id: "pane-worker-2" } }));

    expect(adapter.spawn({
      name: "worker-2", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-leader", workerPaneIds: ["pane-worker-1"] },
    })).toBe("pane-worker-2");
    expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["pane", "get", "pane-leader"]);
    expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "get", "pane-worker-1"]);
    expect(exec).toHaveBeenNthCalledWith(3, "herdr", ["pane", "layout", "--pane", "pane-leader"]);
    expect(exec).toHaveBeenNthCalledWith(4, "herdr", [
      "pane", "split", "--pane", "pane-worker-1", "--direction", "down", "--ratio", "0.5",
      "--cwd", "/repo", "--no-focus",
    ]);
  });

  it("refuses a stale exact Team Worker target without falling back to the leader", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "w4" } }))
      .mockReturnValueOnce(failure("pane_not_found", "pane worker is gone"));

    expect(() => adapter.spawn({
      name: "worker-2", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-leader", workerPaneIds: ["pane-stale"] },
    })).toThrow(/pane_not_found/i);
    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "get", "pane-leader"]);
    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "get", "pane-stale"]);
    expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["split"]));
  });

  it("refuses a Worker pane moved to another leader tab", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "w4" } }))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-moved", tab_id: "tab-b", workspace_id: "w4" } }));

    expect(() => adapter.spawn({
      name: "worker-2", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-leader", workerPaneIds: ["pane-moved"] },
    })).toThrow(/not in the leader tab/i);
    expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["split"]));
  });

  it("retries the transient split-to-shell readiness race before starting Pi", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin", 100))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(failure("agent_pane_busy", "agent target pane is not an available shell"))
      .mockReturnValueOnce(success({ type: "agent_info", agent: { pane_id: "pane-worker" } }));

    expect(adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    })).toBe("pane-worker");
    expect(exec).toHaveBeenCalledTimes(5);
    expect(exec.mock.calls[3]).toEqual(exec.mock.calls[4]);
  });

  it("rejects legacy shell commands and malformed or incomplete start envelopes", () => {
    expect(() => adapter.spawn({
      name: "worker", cwd: "/repo", command: "pi --model unsafe", env: {},
    })).toThrow(/structured argv/i);

    exec.mockReturnValue({ stdout: "not-json", stderr: "", status: 0 });
    expect(() => adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    }))
      .toThrow(/malformed JSON/i);

    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { terminal_id: "not-a-pane" } }));
    expect(() => adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    })).toThrow(/pane\.pane_id/i);

    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(failure("agent_start_failed", "agent unavailable"))
      .mockReturnValueOnce(success({ type: "ok" }));
    expect(() => adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    }))
      .toThrow(/agent_start_failed: agent unavailable/i);
    expect(exec).toHaveBeenLastCalledWith("herdr", ["pane", "close", "pane-worker"]);
  });

  it("closes non-final panes, refuses workspace deletion, and handles pane_not_found idempotently", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker", workspace_id: "w4" } }))
      .mockReturnValueOnce(success({ type: "pane_list", panes: [{ pane_id: "pane-origin" }, { pane_id: "pane-worker" }] }))
      .mockReturnValueOnce(success({ type: "ok" }));
    expect(() => adapter.kill("pane-worker")).not.toThrow();
    expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["pane", "get", "pane-worker"]);
    expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "list", "--workspace", "w4"]);
    expect(exec).toHaveBeenNthCalledWith(3, "herdr", ["pane", "close", "pane-worker"]);

    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker", workspace_id: "w4" } }))
      .mockReturnValueOnce(success({ type: "pane_list", panes: [{ pane_id: "pane-worker" }] }));
    expect(() => adapter.kill("pane-worker")).toThrow(/last pane.*delete the workspace/i);

    exec.mockReturnValueOnce(failure("pane_not_found", "pane worker not found"));
    expect(() => adapter.kill("pane-worker")).not.toThrow();

    exec.mockReturnValueOnce(failure("permission_denied", "not allowed"));
    expect(() => adapter.kill("pane-worker")).toThrow(/permission_denied/i);
  });

  it("requires both pane presence and a live shell process, while distinguishing missing and errors", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(success({ type: "pane_process_info", process_info: { pane_id: "pane-worker", shell_pid: 4242 } }));
    expect(adapter.isAlive("pane-worker")).toBe(true);
    expect(exec).toHaveBeenNthCalledWith(1, "herdr", ["pane", "get", "pane-worker"]);
    expect(exec).toHaveBeenNthCalledWith(2, "herdr", ["pane", "process-info", "--pane", "pane-worker"]);

    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(success({ type: "pane_process_info", process_info: { pane_id: "pane-worker", shell_pid: null } }));
    expect(adapter.isAlive("pane-worker")).toBe(false);

    exec.mockReturnValueOnce(failure("pane_not_found", "pane worker not found"));
    expect(adapter.isAlive("pane-worker")).toBe(false);

    exec.mockReturnValueOnce(failure("server_unavailable", "socket disconnected"));
    expect(() => adapter.isAlive("pane-worker")).toThrow(/server_unavailable/i);
    expect(adapter.isAlive("")).toBe(false);
  });

  it("renames only the originating pane and keeps title failures non-fatal", () => {
    exec.mockReturnValue(success({ pane_id: "pane-origin" }));
    adapter.setTitle("team-a: worker");
    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "rename", "pane-origin", "team-a: worker"]);

    exec.mockReturnValue(failure("pane_not_found", "closed"));
    expect(() => adapter.setTitle("ignored")).not.toThrow();
    vi.stubEnv("HERDR_PANE_ID", "");
    adapter.setTitle("no target");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("does not support separate OS windows", () => {
    expect(adapter.supportsWindows()).toBe(false);
    expect(() => adapter.spawnWindow({ name: "worker", cwd: "/repo", argv: ["pi"], env: {} }))
      .toThrow(/does not support spawning separate OS windows/i);
    expect(adapter.isWindowAlive("anything")).toBe(false);
  });
});
