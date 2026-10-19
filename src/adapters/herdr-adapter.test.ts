import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { HerdrAdapter, herdrCarrierName } from "./herdr-adapter";
import { nodeHostEnv, type ExecOutcome } from "../env/host-env";
import { HerdrRequestError } from "../utils/herdr-reply";
import type { SpawnOptions } from "../utils/terminal-adapter";
import type { TeamPaneLayout } from "../utils/team-pane-layout";

const success = (result: unknown): ExecOutcome => ({ kind: "exited", stdout: JSON.stringify({ result }), stderr: "", status: 0 });
const failure = (code: string, message = "synthetic error"): ExecOutcome => ({ kind: "exited", stdout: "", stderr: JSON.stringify({ error: { code, message } }), status: 1 });
const ready = (pane_id = "new", name = "worker") => ({ type: "agent_started", argv: ["pi"], agent: { agent: "pi", pane_id, terminal_id: "terminal", name, interactive_ready: true } });
const rect = (pane_id: string, width: number, height: number, x = 60, y = 0) => ({ pane_id, rect: { x, y, width, height } });
const options = (workers: string[] = [], paneLayout?: TeamPaneLayout): SpawnOptions => ({ name: "worker", cwd: "/repo", argv: ["pi"], env: {},
  panePlacement: { leaderPaneId: "leader", workerPaneIds: workers, paneLayout } });
const adaptive: TeamPaneLayout = { leader_share: 0.6, worker_tiling: "adaptive" };

describe("HerdrAdapter async contract", () => {
  const adapter = new HerdrAdapter();
  let run: MockInstance<typeof nodeHostEnv.exec.run>;
  let panes: ReturnType<typeof rect>[];
  beforeEach(() => {
    panes = [rect("leader", 100, 60, 0)];
    run = vi.spyOn(nodeHostEnv.exec, "run").mockImplementation(async (_command, args) => {
      if (args[1] === "server") return success({});
      if (args[1] === "layout") return success({ layout: { tab_id: "tab", workspace_id: "workspace", panes } });
      if (args[1] === "get") return failure("pane_not_found");
      if (args[1] === "split") return success({ pane: { pane_id: "new" } });
      if (args[1] === "rename") return success({});
      if (args[1] === "start") return success(ready());
      throw new Error(`Unexpected fixture command ${args.join(" ")}`);
    });
    vi.spyOn(nodeHostEnv.exec, "runSync").mockImplementation(() => { throw new Error("sync exec reached"); });
    vi.stubEnv("HERDR_ENV", "1"); vi.stubEnv("HERDR_TAB_ID", "tab"); vi.stubEnv("HERDR_PANE_ID", "leader");
    vi.stubEnv("TMUX", ""); vi.stubEnv("TMUX_PANE", "");
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const splitCalls = () => run.mock.calls.filter(([, args]) => args[1] === "split");
  function expectSplit(target: string, direction: string) {
    expect(splitCalls()).toHaveLength(1);
    expect(splitCalls()[0][1]).toEqual(expect.arrayContaining(["split", "--pane", target, "--direction", direction]));
  }

  it("detects usable pane/tab identity even with nested tmux, but requires a direct carrier for launch", async () => {
    expect(await adapter.detect()).toBe(true); expect(adapter.isDirectCarrier()).toBe(true);
    vi.stubEnv("TMUX", "nested"); expect(await adapter.detect()).toBe(true); expect(adapter.isDirectCarrier()).toBe(false);
    vi.stubEnv("TMUX", ""); vi.stubEnv("TMUX_PANE", "%nested"); expect(adapter.isDirectCarrier()).toBe(false);
    run.mockResolvedValue(failure("unavailable")); expect(await adapter.detect()).toBe(false);
    for (const key of ["HERDR_TAB_ID", "HERDR_PANE_ID", "HERDR_ENV"]) {
      vi.stubEnv(key, ""); run.mockClear(); expect(await adapter.detect()).toBe(false); expect(run).not.toHaveBeenCalled();
    }
  });
  it("keeps qualified carrier names valid, bounded and deterministic", () => {
    expect(herdrCarrierName("team-a", "worker")).toBe("team-a-worker");
    const name = herdrCarrierName("rc12-audit-canary-20260810", "reviewer");
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/); expect(name).toHaveLength(32);
    expect(herdrCarrierName("rc12-audit-canary-20260810", "reviewer")).toBe(name);
    expect(herdrCarrierName("rc12-audit-canary-20260810", "maker")).not.toBe(name);
    expect(herdrCarrierName("12 TEAM", "Reviewer")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });
  it("prepares the exact pane before start, with structured argv and allowlisted environment", async () => {
    panes = [rect("leader", 82, 60, 0)];
    const input = { ...options(), cwd: "/repo with spaces", argv: ["pi", "--model", "openai/model;not-a-shell", "--tools", "task_read,task_update"],
      env: { PI_TEAM_NAME: "team-a", PI_AGENT_NAME: "worker", HTTPS_PROXY: "http://127.0.0.1:6152", OTHER: "must-not-pass" } };
    expect(await adapter.prepareSpawn(input)).toBe("new");
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(["layout", "split", "rename"]);
    expect(splitCalls()[0][1]).toEqual(["pane", "split", "--pane", "leader", "--direction", "right", "--ratio", String(50 / 82),
      "--cwd", "/repo with spaces", "--env", "PI_TEAM_NAME=team-a", "--env", "PI_AGENT_NAME=worker", "--env", "HTTPS_PROXY=http://127.0.0.1:6152", "--no-focus"]);
    run.mockResolvedValueOnce(success(ready("new", "team-a-worker")));
    await expect(adapter.startPrepared("new", input)).resolves.toMatchObject({ state: "started" });
    expect(run.mock.calls.at(-1)?.[1]).toEqual(["agent", "start", "team-a-worker", "--kind", "pi", "--pane", "new", "--timeout", "300000", "--", ...input.argv.slice(1)]);
    expect(nodeHostEnv.exec.runSync).not.toHaveBeenCalled();
  });
  it("retains a created target when naming fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const normal = run.getMockImplementation()!;
    run.mockImplementation(async (command, args, config) => args[1] === "rename" ? failure("pane_rename_failed", "label rejected") : normal(command, args, config));
    expect(await adapter.prepareSpawn(options())).toBe("new");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/new.*pane_rename_failed.*label rejected/));
    expect(run.mock.calls.some(([, args]) => args[1] === "close")).toBe(false);
  });
  it("splits the exact last current Worker down in linear mode", async () => {
    panes = [rect("leader", 60, 60, 0), rect("worker-1", 40, 30)];
    await adapter.prepareSpawn(options(["worker-1"])); expectSplit("worker-1", "down");
  });
  it.each(["adaptive", "grid"] as const)("uses live geometry for %s placement", async worker_tiling => {
    panes = [rect("leader", 60, 42, 0), rect("worker", 48, 30)];
    await adapter.prepareSpawn(options(["worker"], { ...adaptive, worker_tiling })); expectSplit("worker", "down");
  });
  it.each([
    [5, 60, 0.9, "linear", false], [100, 5, 0.6, "adaptive", true],
    [30, 5, 0.6, "adaptive", false], [100, 4, 0.6, "adaptive", false],
  ] as const)("checks first split geometry %sx%s, share %s (%s)", async (width, height, leader_share, worker_tiling, viable) => {
    panes = [rect("leader", width, height, 0)];
    const prepare = adapter.prepareSpawn(options([], { leader_share, worker_tiling }));
    if (viable) { await prepare; expectSplit("leader", "right"); }
    else { await expect(prepare).rejects.toThrow(/too narrow|insufficient/i); expect(splitCalls()).toEqual([]); }
  });
  it("ranks viable panes by normalized dimension, then pane ID, rather than area or input order", async () => {
    panes = [rect("leader", 60, 70, 0), rect("invalid", 100, 4), rect("area", 50, 30), rect("score-z", 40, 36, 60, 30), rect("score-a", 40, 36, 60, 30)];
    await adapter.prepareSpawn(options(["invalid", "area", "score-z", "score-a"], adaptive)); expectSplit("score-a", "down");
  });
  it("re-reads geometry after each split and follows reflow", async () => {
    await adapter.prepareSpawn(options([], adaptive)); expectSplit("leader", "right"); run.mockClear();
    panes = [rect("leader", 60, 60, 0), rect("worker-1", 40, 60)];
    await adapter.prepareSpawn(options(["worker-1"], adaptive)); expectSplit("worker-1", "down"); run.mockClear();
    panes = [rect("leader", 60, 60, 0), rect("worker-1", 40, 15), rect("worker-2", 40, 30, 60, 15)];
    await adapter.prepareSpawn(options(["worker-1", "worker-2"], adaptive)); expectSplit("worker-2", "down");
  });
  it.each([
    [50, 20, 2, true, "right"], [50, 20, 3, true, "down"], [50, 50, 2, true, "down"],
    [41, 11, 2, true, "right"], [39, 11, 2, true, "down"], [37, 19, 2, true, "down"],
    [20, 9, 3, false, "down"], [20, 11, 3, true, "down"], [39, 5, 2, false, "right"],
  ] as const)("checks axis and child minima for %sx%s with bias %s", async (width, height, columns_per_row, viable, direction) => {
    panes = [rect("leader", 60, 60, 0), rect("worker", width, height)];
    const prepare = adapter.prepareSpawn(options(["worker"], { ...adaptive, columns_per_row }));
    if (viable) { await prepare; expectSplit("worker", direction); }
    else { await expect(prepare).rejects.toThrow(/insufficient.*geometry/i); expect(splitCalls()).toEqual([]); }
  });
  it("falls back to the other axis when the longer axis is too narrow, as in the 2026-10-19 wedge", async () => {
    // Every pane prefers a side-by-side split that leaves 12-13 columns; a downward split still fits 20x5.
    panes = [rect("leader", 34, 25, 0), rect("w-a", 26, 13, 34, 0), rect("w-b", 26, 12, 34, 13),
      rect("w-c", 25, 7, 60, 0), rect("w-d", 25, 6, 60, 7), rect("w-e", 25, 12, 60, 13)];
    await adapter.prepareSpawn(options(["w-a", "w-b", "w-c", "w-d", "w-e"], adaptive)); expectSplit("w-a", "down");
  });
  it("prefers any pane that fits its longer axis over a higher-scoring fallback pane", async () => {
    panes = [rect("leader", 60, 60, 0), rect("fallback", 44, 9, 60, 0), rect("preferred", 41, 8, 60, 10)];
    await adapter.prepareSpawn(options(["fallback", "preferred"], { ...adaptive, columns_per_row: 5 })); expectSplit("preferred", "right");
  });
  it("enforces registered Worker capacity without splitting", async () => {
    await expect(adapter.prepareSpawn(options(["closed"], { ...adaptive, worker_limit: 1 }))).rejects.toThrow(/Worker limit 1/);
    expect(splitCalls()).toEqual([]);
  });
  it("excludes wrong-tab, stale, vertical-region and unregistered candidates", async () => {
    panes = [rect("leader", 60, 60, 0), rect("vertical", 100, 60, 60, 1), rect("rogue", 100, 60), rect("valid", 40, 30)];
    const normal = run.getMockImplementation()!;
    run.mockImplementation(async (command, args, config) => args[1] === "get" && args[2] === "moved"
      ? success({ pane: { pane_id: "moved", tab_id: "other", workspace_id: "workspace" } }) : normal(command, args, config));
    await adapter.prepareSpawn(options(["closed", "moved", "vertical", "valid"], adaptive)); expectSplit("valid", "down");
  });
  describe.each(["linear", "adaptive", "grid"] as const)("closed Worker panes (%s)", worker_tiling => {
    it.each([{ present: [] as string[] }, { present: ["worker-a"] }])("uses only live registered candidates $present", async ({ present }) => {
      panes = [rect("leader", present.length ? 60 : 100, 60, 0), ...present.map(id => rect(id, 40, 60))];
      await adapter.prepareSpawn(options(["worker-a", "worker-b"], { ...adaptive, worker_tiling, worker_limit: 3 }));
      expectSplit(present.length ? "worker-a" : "leader", present.length ? "down" : "right");
      await expect(adapter.startPrepared("new", options())).resolves.toMatchObject({ state: "started" });
    });
    it.each([
      ["leader", failure("pane_not_found"), "pane_not_found"],
      ["worker-a", failure("permission_denied", "pane_not_found is diagnostic text only"), "permission_denied"],
      ["worker-a", { kind: "exited", stdout: "bad-json", stderr: "", status: 1 }, "malformed JSON"],
      ["worker-a", { kind: "exited", stdout: "bad-json", stderr: JSON.stringify({ error: { code: "pane_not_found" } }), status: 1 }, "malformed JSON"],
      ["worker-a", { kind: "timeout", afterMs: 2000 }, "herdr_get_timeout"],
    ] as const)("refuses %s query failure: %s", async (target, reply, message) => {
      panes = [rect("leader", 60, 60, 0), rect("worker-b", 40, 60)];
      const normal = run.getMockImplementation()!;
      run.mockImplementation(async (command, args, config) => (args[1] === "get" && args[2] === target) || (target === "leader" && args[1] === "layout") ? reply : normal(command, args, config));
      await expect(adapter.prepareSpawn(options(["worker-a", "worker-b"], { ...adaptive, worker_tiling }))).rejects.toThrow(message);
      expect(splitCalls()).toEqual([]);
    });
  });
  it("preserves structured error code and text without treating diagnostic text as absence", async () => {
    run.mockResolvedValue(failure("pane_not_found", "pane worker not found"));
    await expect(adapter.renamePane("worker", "label")).rejects.toBeInstanceOf(HerdrRequestError);
    await expect(adapter.prepareSpawn(options())).rejects.toMatchObject({ code: "pane_not_found", fact: "pane_not_found: pane worker not found" });
    expect(await adapter.isAlive("worker")).toBe(false); await adapter.kill("worker");
    run.mockResolvedValue(failure("server_unavailable", "pane_not_found is diagnostic text only"));
    await expect(adapter.isAlive("worker")).rejects.toThrow("server_unavailable"); await expect(adapter.kill("worker")).rejects.toThrow("server_unavailable");
  });
  it("keeps a split timeout ambiguous and never closes or starts another target", async () => {
    const normal = run.getMockImplementation()!;
    run.mockImplementation(async (command, args, config) => {
      expect(config?.timeoutMs).toBeGreaterThan(0); expect(config?.timeoutMs).toBeLessThanOrEqual(2000);
      return args[1] === "split" ? { kind: "timeout", afterMs: 2000 } : normal(command, args, config);
    });
    await expect(adapter.prepareSpawn(options())).rejects.toThrow("herdr_split_timeout");
    expect(splitCalls()).toHaveLength(1); expect(run.mock.calls.some(([, args]) => ["close", "start"].includes(args[1]))).toBe(false);
  });
  it("retries only decisive busy on the same pane within the warming-shell bound", async () => {
    vi.useFakeTimers();
    run.mockResolvedValueOnce(failure("agent_pane_busy")).mockResolvedValueOnce(success(ready()));
    const started = adapter.startPrepared("new", options());
    await vi.advanceTimersByTimeAsync(50); await expect(started).resolves.toMatchObject({ state: "started" });
    expect(run.mock.calls[0]).toEqual(run.mock.calls[1]);
    run.mockClear().mockResolvedValue({ kind: "timeout", afterMs: 2000 });
    await expect(adapter.startPrepared("new", options())).resolves.toEqual({ state: "unknown", fact: "timeout" });
    await vi.advanceTimersByTimeAsync(6000); expect(run).toHaveBeenCalledOnce();
    run.mockClear().mockResolvedValue(failure("agent_pane_busy"));
    const refused = adapter.startPrepared("new", options()); await vi.advanceTimersByTimeAsync(5000);
    await expect(refused).resolves.toMatchObject({ state: "refused" });
    expect(run.mock.calls.every(call => JSON.stringify(call) === JSON.stringify(run.mock.calls[0]))).toBe(true);
  });
  it.each(["", "  \n"])("preserves stderr readiness timeout with empty stdout %j without retry", async stdout => {
    run.mockResolvedValue({ kind: "exited", status: 1, stdout, stderr: JSON.stringify({ error: { code: "timeout", message: "timed out waiting for agent startup" } }) });
    await expect(adapter.startPrepared("new", options())).resolves.toEqual({ state: "unknown", fact: "timeout: timed out waiting for agent startup" });
    expect(run).toHaveBeenCalledOnce();
  });
  it("keeps decisive stderr refusal and never masks nonempty stdout", async () => {
    const stderr = JSON.stringify({ error: { code: "pane_not_found", message: "pane missing" } });
    run.mockResolvedValueOnce({ kind: "exited", status: 1, stdout: "", stderr });
    await expect(adapter.startPrepared("new", options())).resolves.toEqual({ state: "refused", fact: "pane_not_found: pane missing" });
    run.mockResolvedValueOnce({ kind: "exited", status: 0, stdout: JSON.stringify({ result: ready() }), stderr });
    await expect(adapter.startPrepared("new", options())).resolves.toMatchObject({ state: "started" });
    run.mockResolvedValueOnce({ kind: "exited", status: 1, stdout: "malformed", stderr });
    await expect(adapter.startPrepared("new", options())).resolves.toMatchObject({ state: "unknown" });
    run.mockResolvedValueOnce({ kind: "exited", status: 0, stdout: "", stderr: JSON.stringify({ result: ready() }) });
    await expect(adapter.startPrepared("new", options())).resolves.toMatchObject({ state: "unknown" });
  });
  it.each([
    { ...ready(), agent: { ...ready().agent, agent: undefined } },
    { ...ready(), agent: { ...ready().agent, agent: "claude" } },
    { ...ready(), argv: ["not-pi"] }, { ...ready(), agent: { ...ready().agent, pane_id: "wrong" } },
    { ...ready(), agent: { ...ready().agent, name: "wrong" } },
    { ...ready(), agent: { ...ready().agent, terminal_id: "" } },
    { ...ready(), agent: { ...ready().agent, interactive_ready: false } },
  ])("retains the exact pane on contradictory ready evidence %j", async result => {
    const pane = await adapter.prepareSpawn(options()); run.mockClear().mockResolvedValue(success(result));
    await expect(adapter.startPrepared(pane, options())).resolves.toEqual({ state: "unknown", fact: "malformed_start_reply" });
    expect(run).toHaveBeenCalledOnce(); expect(run.mock.calls[0][1]).toContain(pane);
  });
  it("rejects legacy commands, malformed replies and missing split identity", async () => {
    await expect(adapter.prepareSpawn({ ...options(), argv: undefined, command: "pi" })).rejects.toThrow("structured argv");
    run.mockResolvedValueOnce({ kind: "exited", status: 0, stdout: "not-json", stderr: "" });
    await expect(adapter.prepareSpawn(options())).rejects.toThrow("malformed JSON");
    const normal = run.getMockImplementation()!;
    run.mockImplementation(async (command, args, config) => args[1] === "split" ? success({ pane: { terminal_id: "not-a-pane" } }) : normal(command, args, config));
    await expect(adapter.prepareSpawn(options())).rejects.toThrow("pane.pane_id");
  });
  it("leaves metadata unchanged during title projection and refuses separate windows", async () => {
    adapter.setTitle("team: worker"); vi.stubEnv("HERDR_PANE_ID", ""); adapter.setTitle("no target"); expect(run).not.toHaveBeenCalled();
    expect(adapter.supportsWindows()).toBe(false); expect(await adapter.isWindowAlive("anything")).toBe(false);
    await expect(adapter.prepareWindow(options())).rejects.toThrow("does not support spawning separate OS windows");
  });
});
