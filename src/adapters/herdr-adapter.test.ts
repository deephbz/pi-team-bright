import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { HerdrAdapter, herdrCarrierName } from "./herdr-adapter";
import { nodeHostEnv } from "../env/host-env";
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
  let exec: MockInstance<typeof terminalAdapter.execCommand>;

  beforeEach(() => {
    adapter = new HerdrAdapter();
    exec = vi.spyOn(terminalAdapter, "execCommand");
    vi.spyOn(nodeHostEnv.exec, "run").mockImplementation(async (command, args) => ({ kind: "exited", ...terminalAdapter.execCommand(command, [...args]) }));
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
      "--timeout", "300000",
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

  it("enforces the first leader share and 20x5 geometry before splitting adaptively", () => {
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ type: "pane_layout", layout: {
        tab_id: "tab-a", workspace_id: "workspace-a",
        panes: [{ pane_id: "pane-leader", rect: { x: 0, y: 0, width: 100, height: 5 } }],
      } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-new" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-new", "worker-new"));

    adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: [],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive" },
      },
    });
    expect(exec).toHaveBeenCalledWith("herdr", expect.arrayContaining([
      "pane", "split", "--pane", "pane-leader", "--direction", "right", "--ratio", "0.6",
    ]));
  });

  it("refuses the first Worker when the leader or Worker region is below 20x5", () => {
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ type: "pane_layout", layout: {
        tab_id: "tab-a", workspace_id: "workspace-a",
        panes: [{ pane_id: "pane-leader", rect: { x: 0, y: 0, width: 30, height: 5 } }],
      } }));

    expect(() => adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: [],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive" },
      },
    })).toThrow(/insufficient.*first Worker/i);
    expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["pane", "split"]));
  });

  it("uses grid as a read-compatible alias for live adaptive placement", () => {
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-1", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ type: "pane_layout", layout: {
        tab_id: "tab-a", workspace_id: "workspace-a",
        panes: [
          { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 42 } },
          { pane_id: "worker-1", rect: { x: 60, y: 0, width: 48, height: 30 } },
        ],
      } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-2" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-2", "worker-2"));

    expect(adapter.spawn({
      name: "worker-2", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: ["worker-1"],
        paneLayout: { leader_share: 0.6, worker_tiling: "grid" },
      },
    })).toBe("worker-2");
    expect(exec).toHaveBeenCalledWith("herdr", [
      "pane", "split", "--pane", "worker-1", "--direction", "down", "--ratio", "0.5",
      "--cwd", "/repo", "--no-focus",
    ]);
  });

  it("ranks viable registered panes by max(width / columns_per_row, height) and splits the visual winner", () => {
    const layout = success({ type: "pane_layout", layout: { tab_id: "tab-a", workspace_id: "workspace-a", panes: [
      { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 42 } },
      { pane_id: "worker-a", rect: { x: 60, y: 0, width: 100, height: 4 } },
      { pane_id: "worker-b", rect: { x: 60, y: 0, width: 48, height: 30 } },
      { pane_id: "worker-c", rect: { x: 60, y: 0, width: 40, height: 30 } },
    ] } });
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-a", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-b", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-c", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(layout)
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-new" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-new", "worker-new"));

    expect(adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader",
        workerPaneIds: ["worker-a", "worker-b", "worker-c"],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive", columns_per_row: 2 },
      },
    })).toBe("worker-new");
    expect(exec).toHaveBeenCalledWith("herdr", [
      "pane", "split", "--pane", "worker-b", "--direction", "down", "--ratio", "0.5",
      "--cwd", "/repo", "--no-focus",
    ]);
  });

  it("reports insufficient geometry without splitting when every registered candidate is too small", () => {
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-a", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ type: "pane_layout", layout: { tab_id: "tab-a", workspace_id: "workspace-a", panes: [
        { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 42 } },
        { pane_id: "worker-a", rect: { x: 60, y: 0, width: 39, height: 5 } },
      ] } }));

    expect(() => adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: ["worker-a"],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive" },
      },
    })).toThrow(/insufficient.*geometry/i);
    expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["pane", "split"]));
  });

  it("ranks by normalized dimension instead of area", () => {
    const layout = success({ type: "pane_layout", layout: { tab_id: "tab-a", workspace_id: "workspace-a", panes: [
      { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 70 } },
      { pane_id: "worker-area", rect: { x: 60, y: 0, width: 50, height: 30 } },
      { pane_id: "worker-score", rect: { x: 60, y: 30, width: 40, height: 36 } },
    ] } });
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-area", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-score", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(layout)
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-new" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-new", "worker-new"));

    expect(adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: ["worker-area", "worker-score"],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive", columns_per_row: 2 },
      },
    })).toBe("worker-new");
    expect(exec).toHaveBeenCalledWith("herdr", expect.arrayContaining([
      "pane", "split", "--pane", "worker-score", "--direction", "down",
    ]));
  });

  it("re-reads live geometry after each split and follows reflowed panes", () => {
    exec
      // First Worker: leader 100x60, leader share 0.6 leaves a 40x60 region.
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ type: "pane_layout", layout: {
        tab_id: "tab-a", workspace_id: "workspace-a",
        panes: [{ pane_id: "pane-leader", rect: { x: 0, y: 0, width: 100, height: 60 } }],
      } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-1" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-1", "worker-1"))
      // Second Worker: the live layout makes worker-1 a 40x60 down-split candidate.
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-1", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ type: "pane_layout", layout: {
        tab_id: "tab-a", workspace_id: "workspace-a",
        panes: [
          { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 60 } },
          { pane_id: "worker-1", rect: { x: 60, y: 0, width: 40, height: 60 } },
        ],
      } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-2" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-2", "worker-2"))
      // Third Worker: reflow leaves worker-2 larger; it must win over stale worker-1 geometry.
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-1", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-2", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ type: "pane_layout", layout: {
        tab_id: "tab-a", workspace_id: "workspace-a",
        panes: [
          { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 60 } },
          { pane_id: "worker-1", rect: { x: 60, y: 0, width: 40, height: 15 } },
          { pane_id: "worker-2", rect: { x: 60, y: 15, width: 40, height: 30 } },
        ],
      } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-3" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-3", "worker-3"));

    const policy = { leader_share: 0.6, worker_tiling: "adaptive" as const };
    expect(adapter.spawn({ name: "worker-1", cwd: "/repo", argv: ["pi"], env: {}, panePlacement: { leaderPaneId: "pane-leader", workerPaneIds: [], paneLayout: policy } })).toBe("worker-1");
    expect(adapter.spawn({ name: "worker-2", cwd: "/repo", argv: ["pi"], env: {}, panePlacement: { leaderPaneId: "pane-leader", workerPaneIds: ["worker-1"], paneLayout: policy } })).toBe("worker-2");
    expect(adapter.spawn({ name: "worker-3", cwd: "/repo", argv: ["pi"], env: {}, panePlacement: { leaderPaneId: "pane-leader", workerPaneIds: ["worker-1", "worker-2"], paneLayout: policy } })).toBe("worker-3");
    expect(exec).toHaveBeenCalledWith("herdr", expect.arrayContaining([
      "pane", "split", "--pane", "worker-2", "--direction", "down",
    ]));
  });

  it("breaks equal normalized scores by pane ID, independent of input order", () => {
    const layout = success({ type: "pane_layout", layout: { tab_id: "tab-a", workspace_id: "workspace-a", panes: [
      { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 60 } },
      { pane_id: "worker-z", rect: { x: 60, y: 0, width: 40, height: 20 } },
      { pane_id: "worker-a", rect: { x: 60, y: 20, width: 40, height: 20 } },
    ] } });
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-z", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-a", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(layout)
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-new" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-new", "worker-new"));

    adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: ["worker-z", "worker-a"],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive", columns_per_row: 2 },
      },
    });
    expect(exec).toHaveBeenCalledWith("herdr", expect.arrayContaining([
      "pane", "split", "--pane", "worker-a", "--direction", "right",
    ]));
  });

  it.each([
    [2, "right"],
    [3, "down"],
  ] as const)("uses bias %s to choose the visual axis (%s)", (columnsPerRow, direction) => {
    const layout = success({ type: "pane_layout", layout: { tab_id: "tab-a", workspace_id: "workspace-a", panes: [
      { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 60 } },
      { pane_id: "worker", rect: { x: 60, y: 0, width: 50, height: 20 } },
    ] } });
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(layout)
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-new" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-new", "worker-new"));

    adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: ["worker"],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive", columns_per_row: columnsPerRow },
      },
    });
    expect(exec).toHaveBeenCalledWith("herdr", expect.arrayContaining([
      "pane", "split", "--pane", "worker", "--direction", direction,
    ]));
  });

  it("uses height for a square 50x50 pane", () => {
    const layout = success({ type: "pane_layout", layout: { tab_id: "tab-a", workspace_id: "workspace-a", panes: [
      { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 60 } },
      { pane_id: "worker", rect: { x: 60, y: 0, width: 50, height: 50 } },
    ] } });
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(layout)
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-new" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-new", "worker-new"));

    adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: ["worker"],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive", columns_per_row: 2 },
      },
    });
    expect(exec).toHaveBeenCalledWith("herdr", expect.arrayContaining([
      "pane", "split", "--pane", "worker", "--direction", "down",
    ]));
  });

  it.each([
    [41, 11, true, "right", 2],
    [39, 11, false, "right", 2],
    [37, 19, true, "down", 2],
    [20, 9, false, "down", 3],
    [20, 11, true, "down", 3],
  ] as const)("handles odd dimensions %sx%s against the 20x5 minima", (width, height, viable, direction, columnsPerRow) => {
    const layout = success({ type: "pane_layout", layout: { tab_id: "tab-a", workspace_id: "workspace-a", panes: [
      { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 60 } },
      { pane_id: "worker", rect: { x: 60, y: 0, width, height } },
    ] } });
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(layout);
    if (viable) {
      exec
        .mockReturnValueOnce(success({ pane: { pane_id: "worker-new" } }))
        .mockReturnValueOnce(renamed)
        .mockReturnValueOnce(readyStart("worker-new", "worker-new"));
      adapter.spawn({
        name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
        panePlacement: {
          leaderPaneId: "pane-leader", workerPaneIds: ["worker"],
          paneLayout: { leader_share: 0.6, worker_tiling: "adaptive", columns_per_row: columnsPerRow },
        },
      });
      expect(exec).toHaveBeenCalledWith("herdr", expect.arrayContaining([
        "pane", "split", "--pane", "worker", "--direction", direction,
      ]));
    } else {
      expect(() => adapter.spawn({
        name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
        panePlacement: {
          leaderPaneId: "pane-leader", workerPaneIds: ["worker"],
          paneLayout: { leader_share: 0.6, worker_tiling: "adaptive", columns_per_row: columnsPerRow },
        },
      })).toThrow(/insufficient.*geometry/i);
      expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["pane", "split"]));
    }
  });

  it("enforces the Worker limit before geometry queries", () => {
    expect(() => adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: ["worker-existing"],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive", worker_limit: 1 },
      },
    })).toThrow(/Worker limit 1/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("skips stale and wrong-tab candidates, then selects a valid registered pane", () => {
    const layout = success({ type: "pane_layout", layout: { tab_id: "tab-a", workspace_id: "workspace-a", panes: [
      { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 60 } },
      { pane_id: "worker-valid", rect: { x: 60, y: 0, width: 40, height: 30 } },
    ] } });
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(failure("pane_not_found", "stale"))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-moved", tab_id: "tab-b", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-valid", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(layout)
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-new" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-new", "worker-new"));

    adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: ["worker-stale", "worker-moved", "worker-valid"],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive" },
      },
    });
    expect(exec).toHaveBeenCalledWith("herdr", expect.arrayContaining([
      "pane", "split", "--pane", "worker-valid",
    ]));
  });

  it("excludes vertical-region candidates and panes absent from registration", () => {
    const layout = success({ type: "pane_layout", layout: { tab_id: "tab-a", workspace_id: "workspace-a", panes: [
      { pane_id: "pane-leader", rect: { x: 0, y: 0, width: 60, height: 60 } },
      { pane_id: "worker-vertical", rect: { x: 60, y: 1, width: 100, height: 60 } },
      { pane_id: "rogue-not-registered", rect: { x: 60, y: 0, width: 100, height: 60 } },
      { pane_id: "worker-valid", rect: { x: 60, y: 0, width: 40, height: 30 } },
    ] } });
    exec
      .mockReturnValueOnce(success({ pane: { pane_id: "pane-leader", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-vertical", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-valid", tab_id: "tab-a", workspace_id: "workspace-a" } }))
      .mockReturnValueOnce(layout)
      .mockReturnValueOnce(success({ pane: { pane_id: "worker-new" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(readyStart("worker-new", "worker-new"));

    adapter.spawn({
      name: "worker-new", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: {
        leaderPaneId: "pane-leader", workerPaneIds: ["worker-vertical", "worker-valid"],
        paneLayout: { leader_share: 0.6, worker_tiling: "adaptive" },
      },
    });
    expect(exec).toHaveBeenCalledWith("herdr", expect.arrayContaining([
      "pane", "split", "--pane", "worker-valid",
    ]));
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

  it("returns a receipt before retrying a warming shell on the same pane", async () => {
    vi.useFakeTimers();
    const sleep = vi.spyOn(nodeHostEnv.clock, "sleepSync").mockImplementation(() => {});
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
    expect(exec).toHaveBeenCalledTimes(5);
    expect(sleep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(exec).toHaveBeenCalledTimes(6);
    expect(exec.mock.calls[5][1]).toEqual(exec.mock.calls[4][1]);
    vi.useRealTimers();
  });

  it("prepares asynchronously with bounded calls and preserves an ambiguous split", async () => {
    const run = vi.mocked(nodeHostEnv.exec.run);
    run.mockImplementation(async (_command, args, options) => {
      expect(options?.timeoutMs).toBeGreaterThan(0);
      expect(options?.timeoutMs).toBeLessThanOrEqual(2000);
      if (args[1] === "layout") return { kind: "exited", ...leaderLayout("pane-origin", 100) };
      if (args[1] === "get") return { kind: "exited", ...success({ pane: { pane_id: "pane-origin" } }) };
      return { kind: "timeout", afterMs: options.timeoutMs };
    });
    await expect(adapter.prepareSpawnAsync({ name: "worker", cwd: "/repo", argv: ["pi"], env: {}, panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] } })).rejects.toThrow("herdr_split_timeout");
    expect(exec).not.toHaveBeenCalled();
    expect(run.mock.calls.filter(([, args]) => args[1] === "split")).toHaveLength(1);
    expect(run.mock.calls.some(([, args]) => args[1] === "close" || args[1] === "start")).toBe(false);
  });

  it("retries only decisive busy on the same pane and never retries ambiguous start", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.mocked(nodeHostEnv.exec.run);
      run.mockResolvedValueOnce({ kind: "exited", ...failure("agent_pane_busy", "shell warming") })
        .mockResolvedValueOnce({ kind: "exited", ...readyStart("pane-worker", "worker") });
      const options = { name: "worker", cwd: "/repo", argv: ["pi"], env: { PI_TEAM_LAUNCH_ID: "launch-fixed" } };
      const started = adapter.startPrepared("pane-worker", options);
      await vi.advanceTimersByTimeAsync(50);
      await expect(started).resolves.toMatchObject({ state: "started" });
      expect(run.mock.calls[0]).toEqual(run.mock.calls[1]);
      run.mockClear().mockResolvedValue({ kind: "timeout", afterMs: 2000 });
      await expect(adapter.startPrepared("pane-worker", options)).resolves.toEqual({ state: "unknown", fact: "timeout" });
      await vi.advanceTimersByTimeAsync(6000);
      expect(run).toHaveBeenCalledOnce();
      run.mockClear().mockResolvedValue({ kind: "exited", ...failure("agent_pane_busy", "shell warming") });
      const refused = adapter.startPrepared("pane-worker", options);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(refused).resolves.toMatchObject({ state: "refused" });
      expect(run.mock.calls.every(call => JSON.stringify(call) === JSON.stringify(run.mock.calls[0]))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it.each(["", "  \n"])("preserves the real-Herdr-3 stderr readiness timeout with empty stdout %j and never retries", async stdout => {
    const run = vi.mocked(nodeHostEnv.exec.run);
    // Herdr 0.9.3 real-herdr-3 probe: nonzero exit, empty stdout, JSON error on stderr.
    run.mockResolvedValue({ kind: "exited", status: 1, stdout,
      stderr: '{"error":{"code":"timeout","message":"timed out waiting for agent startup"},"id":"cli:agent:start"}\n' });
    await expect(adapter.startPrepared("pane-worker", { name: "worker", cwd: "/repo", argv: ["pi"], env: {} }))
      .resolves.toEqual({ state: "unknown", fact: "timeout: timed out waiting for agent startup" });
    expect(run).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps decisive stderr refusals and never masks nonempty stdout with stderr", async () => {
    const run = vi.mocked(nodeHostEnv.exec.run);
    const options = { name: "worker", cwd: "/repo", argv: ["pi"], env: {} };
    const stderr = JSON.stringify({ error: { code: "pane_not_found", message: "pane missing" } });
    run.mockResolvedValueOnce({ kind: "exited", status: 1, stdout: "", stderr });
    await expect(adapter.startPrepared("pane-worker", options)).resolves.toEqual({ state: "refused", fact: "pane_not_found: pane missing" });
    run.mockResolvedValueOnce({ kind: "exited", ...readyStart("pane-worker", "worker"), stderr });
    await expect(adapter.startPrepared("pane-worker", options)).resolves.toMatchObject({ state: "started" });
    run.mockResolvedValueOnce({ kind: "exited", status: 1, stdout: "malformed", stderr });
    await expect(adapter.startPrepared("pane-worker", options)).resolves.toEqual({ state: "unknown", fact: "malformed_start_reply" });
    run.mockResolvedValueOnce({ kind: "exited", status: 0, stdout: "", stderr: readyStart("pane-worker", "worker").stdout });
    await expect(adapter.startPrepared("pane-worker", options)).resolves.toEqual({ state: "unknown", fact: "malformed_start_reply" });
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("keeps the pane when interactive recognition is unavailable", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(success({ type: "agent_started", argv: ["pi"], agent: {
        pane_id: "pane-worker", terminal_id: "terminal-worker", name: "worker", interactive_ready: true,
      } }))
      .mockReturnValueOnce(success({ type: "ok" }));

    expect(adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    })).toBe("pane-worker");
    expect(exec.mock.calls.filter(([, args]: [string, string[]]) => args[0] === "agent" && args[1] === "start")).toHaveLength(1);
    expect(exec.mock.calls.some(([, args]) => args[0] === "pane" && args[1] === "close")).toBe(false);
  });

  it("keeps the pane when ready start reports a contradictory detected kind", () => {
    exec
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-origin" } }))
      .mockReturnValueOnce(leaderLayout("pane-origin"))
      .mockReturnValueOnce(success({ type: "pane_info", pane: { pane_id: "pane-worker" } }))
      .mockReturnValueOnce(renamed)
      .mockReturnValueOnce(success({ type: "agent_started", argv: ["pi"], agent: {
        agent: "claude", pane_id: "pane-worker", terminal_id: "terminal-other", name: "worker", interactive_ready: true,
      } }))
      .mockReturnValueOnce(success({ type: "ok" }));

    expect(adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    })).toBe("pane-worker");
    expect(exec.mock.calls.some(([, args]) => args[0] === "pane" && args[1] === "close")).toBe(false);
    expect(exec.mock.calls.filter(([, args]: [string, string[]]) => args[0] === "agent" && args[1] === "start")).toHaveLength(1);
  });

  it("keeps the exact pane for malformed ready argv or target evidence", () => {
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
    expect(spawn()).toBe("pane-worker");
    expect(exec.mock.calls.some(([, args]) => args[0] === "pane" && args[1] === "close")).toBe(false);

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
    expect(spawn()).toBe("pane-worker-2");
    expect(exec.mock.calls.some(([, args]) => args[0] === "pane" && args[1] === "close")).toBe(false);
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
    expect(adapter.spawn({
      name: "worker", cwd: "/repo", argv: ["pi"], env: {},
      panePlacement: { leaderPaneId: "pane-origin", workerPaneIds: [] },
    })).toBe("pane-worker");
    expect(exec.mock.calls.some(([, args]) => args[0] === "pane" && args[1] === "close")).toBe(false);
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
