import { expect, it, vi } from "vitest";
import { HerdrAdapter } from "./herdr-adapter";
import { clearAdapterCache, getTerminalAdapterAsync } from "./terminal-registry";
import { nodeHostEnv, runWithHostEnv, type ExecOutcome, type HostExec } from "../env/host-env";

const ok = (result: unknown): ExecOutcome => ({ kind: "exited", status: 0, stdout: JSON.stringify({ result }), stderr: "" });
const error = (code: string): ExecOutcome => ({ kind: "exited", status: 1, stdout: "", stderr: JSON.stringify({ error: { code, message: "synthetic error" } }) });
const pane = { pane: { pane_id: "worker", workspace_id: "workspace" } };
function host(run: HostExec["run"]) {
  return { ...nodeHostEnv, process: { ...nodeHostEnv.process, env: { HERDR_ENV: "1", HERDR_PANE_ID: "leader", HERDR_TAB_ID: "tab", TMUX: "nested" } },
    exec: { run, runSync: vi.fn(() => { throw new Error("synchronous Herdr reached"); }) } };
}

it("coalesces cold detection, yields the main thread, and preserves Herdr precedence", async () => {
  let finish!: (outcome: ExecOutcome) => void;
  const run = vi.fn(() => new Promise<ExecOutcome>(resolve => { finish = resolve; }));
  const env = host(run);
  await runWithHostEnv(env, async () => {
    const reads = [getTerminalAdapterAsync(), getTerminalAdapterAsync()];
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledExactlyOnceWith("herdr", ["status", "server"], { timeoutMs: 2000 });
    finish(ok({}));
    expect((await Promise.all(reads)).map(adapter => adapter?.name)).toEqual(["herdr", "herdr"]);
    expect((await getTerminalAdapterAsync())?.name).toBe("herdr");
    expect(run).toHaveBeenCalledOnce(); expect(env.exec.runSync).not.toHaveBeenCalled();
  });
});

it("does not cache a detection that completed after cache invalidation", async () => {
  let finish!: (outcome: ExecOutcome) => void;
  const run = vi.fn(() => new Promise<ExecOutcome>(resolve => { finish = resolve; }));
  await runWithHostEnv(host(run), async () => {
    const pending = getTerminalAdapterAsync(); await Promise.resolve();
    clearAdapterCache(); finish(ok({})); await pending;
    run.mockResolvedValue(ok({})); await getTerminalAdapterAsync(); expect(run).toHaveBeenCalledTimes(2);
  });
});

it("closes only the exact non-final pane and verifies absence asynchronously", async () => {
  const run = vi.fn().mockResolvedValueOnce(ok(pane))
    .mockResolvedValueOnce(ok({ panes: [{ pane_id: "leader" }, { pane_id: "worker" }] }))
    .mockResolvedValueOnce(ok({})).mockResolvedValueOnce(error("pane_not_found"));
  const env = host(run);
  await runWithHostEnv(env, async () => {
    const adapter = new HerdrAdapter(); await adapter.killAsync("worker");
    expect(await adapter.isAliveAsync("worker")).toBe(false);
  });
  expect(run.mock.calls.map(call => call[1])).toEqual([
    ["pane", "get", "worker"], ["pane", "list", "--workspace", "workspace"], ["pane", "close", "worker"], ["pane", "get", "worker"],
  ]);
  expect(run.mock.calls.every(call => call[2].timeoutMs > 0 && call[2].timeoutMs <= 2000)).toBe(true);
  expect(env.exec.runSync).not.toHaveBeenCalled();
});

it.each([0, 1, 2])("does not treat command timeout at stop step %i as absence or retry", async step => {
  const replies = [ok(pane), ok({ panes: [{}, {}] }), ok({})];
  replies[step] = { kind: "timeout", afterMs: 2000 };
  const run = vi.fn(async () => replies.shift()!);
  await runWithHostEnv(host(run), async () => {
    await expect(new HerdrAdapter().killAsync("worker")).rejects.toThrow("timeout");
  });
  expect(run).toHaveBeenCalledTimes(step + 1);
});

it.each([
  { value: ok({ pane: { pane_id: "other", workspace_id: "workspace" } }), message: "requested pane" },
  { value: error("permission_denied"), message: "permission_denied" },
  { value: { kind: "exited", stdout: "bad-json", stderr: "", status: 0 } as ExecOutcome, message: "malformed JSON" },
])("rejects uncertain or foreign targets before close: $message", async ({ value, message }) => {
  const run = vi.fn(async (_command: string, _args: readonly string[]) => value);
  await runWithHostEnv(host(run), async () => {
    await expect(new HerdrAdapter().killAsync("worker")).rejects.toThrow(message);
    await expect(new HerdrAdapter().isAliveAsync("worker")).rejects.toThrow(message);
  });
  expect(run.mock.calls.every(call => call[1][1] === "get")).toBe(true);
});

it.each<ExecOutcome>([
  { kind: "timeout", afterMs: 2000 }, { kind: "aborted" }, { kind: "spawn_failed", code: "ENOENT", message: "synthetic missing binary" },
])("preserves unavailable liveness and close outcomes: $kind", async outcome => {
  const run = vi.fn(async () => outcome);
  await runWithHostEnv(host(run), async () => {
    const adapter = new HerdrAdapter();
    await expect(adapter.isAliveAsync("worker")).rejects.toThrow(outcome.kind);
    await expect(adapter.killAsync("worker")).rejects.toThrow(outcome.kind);
  });
  expect(run).toHaveBeenCalledTimes(2);
});

it("refuses the final workspace pane and does not close it", async () => {
  const run = vi.fn().mockResolvedValueOnce(ok(pane)).mockResolvedValueOnce(ok({ panes: [{ pane_id: "worker" }] }));
  await runWithHostEnv(host(run), async () => { await expect(new HerdrAdapter().killAsync("worker")).rejects.toThrow("last pane"); });
  expect(run).toHaveBeenCalledTimes(2);
});

it.each([undefined, "42", 0, -1])("keeps malformed shell evidence %s unknown", async shell_pid => {
  const run = vi.fn().mockResolvedValueOnce(ok(pane)).mockResolvedValueOnce(ok({ process_info: { pane_id: "worker", shell_pid } }));
  await runWithHostEnv(host(run), async () => { await expect(new HerdrAdapter().isAliveAsync("worker")).rejects.toThrow("shell_pid"); });
});

it.each([42, null])("preserves explicit shell evidence %s", async shell_pid => {
  const run = vi.fn().mockResolvedValueOnce(ok(pane)).mockResolvedValueOnce(ok({ process_info: { pane_id: "worker", shell_pid } }));
  await runWithHostEnv(host(run), async () => { expect(await new HerdrAdapter().isAliveAsync("worker")).toBe(shell_pid !== null); });
});
