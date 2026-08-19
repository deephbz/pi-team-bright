import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerdrAdapter, herdrCarrierName } from "./herdr-adapter";
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
const renamed = success({ type: "ok" });

// Official Herdr 0.7.5 and 0.8.0 return after interactive readiness.
const readyStart = (paneId: string, name: string) => success({
  type: "agent_started",
  argv: ["pi"],
  agent: {
    agent: "pi",
    pane_id: paneId,
    terminal_id: `terminal-${paneId}`,
    name,
    interactive_ready: true,
  },
});

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
    vi.stubEnv("TMUX_PANE", "");
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

  it("keeps qualified carrier names valid, bounded, and deterministic", () => {
    expect(herdrCarrierName("team-a", "worker")).toBe("team-a-worker");
    const reviewer = herdrCarrierName("rc12-audit-canary-20260810", "reviewer");
    expect(reviewer).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(reviewer).toHaveLength(32);
    expect(herdrCarrierName("rc12-audit-canary-20260810", "reviewer")).toBe(reviewer);
    expect(herdrCarrierName("rc12-audit-canary-20260810", "maker")).not.toBe(reviewer);
    expect(herdrCarrierName("12 TEAM", "Reviewer")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  it("splits a direct Herdr pane then starts Pi there with structured argv and allowlisted environment", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("pane-worker", "team-a-worker"));

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
    expect(exec).toHaveBeenNthCalledWith(4, "herdr", ["pane", "rename", "pane-worker", "worker"]);
    expect(exec).toHaveBeenNthCalledWith(5, "herdr", [
      "agent", "start", "team-a-worker",
      "--kind", "pi",
      "--pane", "pane-worker",
      "--timeout", "6000",
      "--",
      "--model", "openai/model;not-a-shell", "--tools", "task_read,task_update",
    ]);
    expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["pane", "run"]));
  });

  it("starts the Worker with a warning when its presentation label cannot be applied", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(failure("pane_rename_failed", "label rejected"))
      .mockReturnValueOnce(readyStart("pane-worker", "researcher"));

    expect(adapter.spawn({
      name: "researcher", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    })).toBe("pane-worker");
    expect(exec).toHaveBeenNthCalledWith(4, "herdr", ["pane", "rename", "pane-worker", "researcher"]);
    expect(exec).toHaveBeenNthCalledWith(5, "herdr", expect.arrayContaining(["agent", "start", "researcher"]));
    expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["pane", "close"]));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pane-worker.*pane_rename_failed.*label rejected/i));
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
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("pane-worker-2", "worker-2"));

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

  it("refuses a narrow pane when a valid high leader share rounds to 100%", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(success({ type: "pane_layout", layout: {
        panes: [{ pane_id: "pane-origin", rect: { width: 5 } }],
      } }));

    expect(() => adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-origin", workerPaneIds: [],
        paneLayout: { leader_share: 0.9, worker_tiling: "linear" },
      },
    })).toThrow(/too narrow.*Worker region/i);
    expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["pane", "split"]));
  });

  it("places four grid Workers as a stable 2x2 Worker region", () => {
    const layout = success({ type: "pane_layout", layout: {
      tab_id: "tab-a", workspace_id: "w4",
      panes: [
        { pane_id: "pane-leader", rect: { x: 0, width: 60 } },
        { pane_id: "pane-worker-1", rect: { x: 60, width: 20 } },
        { pane_id: "pane-worker-2", rect: { x: 60, width: 20 } },
        { pane_id: "pane-worker-3", rect: { x: 80, width: 20 } },
      ],
    } });
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-leader" } }))
      .mockReturnValueOnce(success({ type: "pane_layout", layout: { panes: [{ pane_id: "pane-leader", rect: { width: 100 } }] } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-worker-1" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("pane-worker-1", "worker-1"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "w4" } }))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker-1", tab_id: "tab-a", workspace_id: "w4" } }))
      .mockReturnValueOnce(layout)
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-worker-2" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("pane-worker-2", "worker-2"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "w4" } }))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker-1", tab_id: "tab-a", workspace_id: "w4" } }))
      .mockReturnValueOnce(layout)
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-worker-3" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("pane-worker-3", "worker-3"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "w4" } }))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker-2", tab_id: "tab-a", workspace_id: "w4" } }))
      .mockReturnValueOnce(layout)
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-worker-4" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("pane-worker-4", "worker-4"));

    const placement = { leaderPaneId: "pane-leader", paneLayout: { leader_share: 0.6, worker_tiling: "grid" as const } };
    expect(adapter.spawn({ name: "worker-1", cwd: "/repo", argv: ["pi"], env: {}, panePlacement: { ...placement, workerPaneIds: [] } })).toBe("pane-worker-1");
    expect(adapter.spawn({ name: "worker-2", cwd: "/repo", argv: ["pi"], env: {}, panePlacement: { ...placement, workerPaneIds: ["pane-worker-1"] } })).toBe("pane-worker-2");
    expect(adapter.spawn({ name: "worker-3", cwd: "/repo", argv: ["pi"], env: {}, panePlacement: { ...placement, workerPaneIds: ["pane-worker-1", "pane-worker-2"] } })).toBe("pane-worker-3");
    expect(adapter.spawn({ name: "worker-4", cwd: "/repo", argv: ["pi"], env: {}, panePlacement: { ...placement, workerPaneIds: ["pane-worker-1", "pane-worker-2", "pane-worker-3"] } })).toBe("pane-worker-4");

    expect(exec.mock.calls.filter(([, args]: [string, string[]]) => args[0] === "pane" && args[1] === "split").map(([, args]: [string, string[]]) => args)).toEqual([
      expect.arrayContaining(["--pane", "pane-leader", "--direction", "right"]),
      expect.arrayContaining(["--pane", "pane-worker-1", "--direction", "down"]),
      expect.arrayContaining(["--pane", "pane-worker-1", "--direction", "right"]),
      expect.arrayContaining(["--pane", "pane-worker-2", "--direction", "right"]),
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
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(failure("agent_pane_busy", "agent target pane is not an available shell"))
      .mockReturnValueOnce(readyStart("pane-worker", "worker"));

    expect(adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    })).toBe("pane-worker");
    expect(exec).toHaveBeenCalledTimes(6);
    expect(exec.mock.calls[4]).toEqual(exec.mock.calls[5]);
  });

  it("requires the official interactive-ready response without a compatibility retry", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(success({ type: "agent_started", argv: ["pi"], agent: {
        pane_id: "pane-worker", terminal_id: "terminal-worker", name: "worker", interactive_ready: true,
      } }))
      .mockReturnValueOnce(success({ type: "ok" }));

    expect(() => adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    })).toThrow(/interactive recognized Pi agent worker/i);
    expect(exec.mock.calls.filter(([, args]: [string, string[]]) => args[0] === "agent" && args[1] === "start")).toHaveLength(1);
    expect(exec).toHaveBeenLastCalledWith("herdr", ["pane", "close", "pane-worker"]);
  });

  it("closes the exact pane when ready start reports a contradictory detected kind", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(success({ type: "agent_started", argv: ["pi"], agent: {
        agent: "claude", pane_id: "pane-worker", terminal_id: "terminal-other", name: "worker", interactive_ready: true,
      } }))
      .mockReturnValueOnce(success({ type: "ok" }));

    expect(() => adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    })).toThrow(/interactive recognized Pi agent worker/i);
    expect(exec).toHaveBeenLastCalledWith("herdr", ["pane", "close", "pane-worker"]);
    expect(exec.mock.calls.filter(([, args]: [string, string[]]) => args[0] === "agent" && args[1] === "start")).toHaveLength(1);
  });

  it("closes the exact pane for malformed ready argv or target evidence", () => {
    const spawn = () => adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    });
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(success({ type: "agent_started", argv: ["not-pi"], agent: {
        pane_id: "pane-worker", terminal_id: "terminal-worker", name: "worker", launch_pending: true,
      } }))
      .mockReturnValueOnce(success({ type: "ok" }));
    expect(spawn).toThrow(/canonical Pi argv/i);
    expect(exec).toHaveBeenLastCalledWith("herdr", ["pane", "close", "pane-worker"]);

    exec.mockReset();
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker-2" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(success({ type: "agent_started", argv: ["pi"], agent: {
        pane_id: "wrong-pane", terminal_id: "terminal-worker", name: "worker", launch_pending: true,
      } }))
      .mockReturnValueOnce(success({ type: "ok" }));
    expect(spawn).toThrow(/exact managed target worker in pane pane-worker-2/i);
    expect(exec).toHaveBeenLastCalledWith("herdr", ["pane", "close", "pane-worker-2"]);
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
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(failure("agent_start_failed", "agent unavailable"))
      .mockReturnValueOnce(success({ type: "ok" }));
    expect(() => adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    }))
      .toThrow(/agent_start_failed: agent unavailable/i);
    expect(exec).toHaveBeenLastCalledWith("herdr", ["pane", "close", "pane-worker"]);
    expect(exec.mock.calls.filter(([, args]: [string, string[]]) => args[0] === "agent" && args[1] === "start")).toHaveLength(1);
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

  it("leaves Herdr pane and recognized-agent metadata unchanged during title projection", () => {
    adapter.setTitle("team-a: worker");
    vi.stubEnv("HERDR_PANE_ID", "");
    adapter.setTitle("no target");
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not support separate OS windows", () => {
    expect(adapter.supportsWindows()).toBe(false);
    expect(() => adapter.spawnWindow({ name: "worker", cwd: "/repo", argv: ["pi"], env: {} }))
      .toThrow(/does not support spawning separate OS windows/i);
    expect(adapter.isWindowAlive("anything")).toBe(false);
  });
});
