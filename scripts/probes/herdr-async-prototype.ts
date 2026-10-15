/** Isolated terminal-path benchmark. Synthetic Herdr replies; no panes, Pis or Team writes. */
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { HerdrAdapter } from "../../src/adapters/herdr-adapter";
import { clearAdapterCache, getTerminalAdapter, getTerminalAdapterAsync } from "../../src/adapters/terminal-registry";
import { nodeHostEnv, runWithHostEnv, type ExecOutcome } from "../../src/env/host-env";

const rounds = Number(process.argv[2] ?? 10);
const real = process.argv[3] === "real-detect";
const pauseMs = 20;
const childScript = `setTimeout(() => { process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]); process.exitCode=Number(process.argv[3]); }, ${pauseMs})`;

async function main() {
  const samples: unknown[] = [];
  const paths = real ? ["cold-detection"] : ["registration", "session_start", "ensure_launch_terminal", "worker_stop_terminal", "cold-detection"];
  for (const path of paths) for (let round = 0; round < rounds; round++) {
    for (const variant of ["before", "after"]) {
      let closed = false, syncCalls = 0, asyncCalls = 0;
      const reply = (args: readonly string[]) => {
        let result: unknown = {};
        if (args[0] === "pane" && args[1] === "get") {
          if (args[2] === "worker" && closed) return { stdout: "", stderr: JSON.stringify({ error: { code: "pane_not_found", message: "synthetic closed pane" } }), status: 1 };
          result = { pane: { pane_id: args[2], workspace_id: "workspace", tab_id: "tab" } };
        }
        if (args[1] === "list") result = { panes: [{ pane_id: "leader" }, { pane_id: "worker" }] };
        if (args[1] === "layout") result = { layout: { workspace_id: "workspace", tab_id: "tab", panes: [{ pane_id: "leader", rect: { x: 0, y: 0, width: 160, height: 40 } }] } };
        if (args[1] === "split") result = { pane: { pane_id: "worker" } };
        if (args[1] === "process-info") result = { process_info: { pane_id: "worker", shell_pid: 42 } };
        return { stdout: JSON.stringify({ result }), stderr: "", status: 0 };
      };
      const env = { ...nodeHostEnv,
        process: { ...nodeHostEnv.process, env: { ...nodeHostEnv.process.env, HERDR_ENV: "1", HERDR_PANE_ID: "leader", HERDR_TAB_ID: "tab", TMUX: "", TMUX_PANE: "" } },
        exec: {
          runSync: (command: string, args: readonly string[]) => {
            syncCalls++;
            if (real) return nodeHostEnv.exec.runSync(command, args);
            const result = reply(args);
            const outcome = nodeHostEnv.exec.runSync(process.execPath, ["-e", childScript, result.stdout, result.stderr, String(result.status)]);
            if (args[1] === "close" && outcome.status === 0) closed = true;
            return outcome;
          },
          run: async (command: string, args: readonly string[], options: { timeoutMs: number }): Promise<ExecOutcome> => {
            asyncCalls++;
            if (real) return nodeHostEnv.exec.run(command, args, options);
            const result = reply(args);
            const outcome = await nodeHostEnv.exec.run(process.execPath, ["-e", childScript, result.stdout, result.stderr, String(result.status)], options);
            if (args[1] === "close" && outcome.kind === "exited" && outcome.status === 0) closed = true;
            return outcome;
          },
        },
      };
      const uptime = execFileSync("uptime", { encoding: "utf8" }).trim();
      await runWithHostEnv(env, async () => {
        clearAdapterCache();
        const adapter = new HerdrAdapter();
        const start = performance.now();
        const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - start), 0));
        if (path === "registration" && variant === "before") {
          if (getTerminalAdapter()?.name !== "herdr") throw new Error("Detection failed");
        } else if ((path === "session_start" && variant === "after") || path === "cold-detection") {
          const detected = variant === "before" ? getTerminalAdapter() : await getTerminalAdapterAsync();
          if (detected?.name !== "herdr") throw new Error("Detection failed");
        } else if (path === "ensure_launch_terminal") {
          const pane = await adapter.prepareSpawnAsync({ name: "worker", cwd: "/synthetic", argv: ["pi"], env: {}, panePlacement: { leaderPaneId: "leader", workerPaneIds: [] } });
          if (pane !== "worker") throw new Error("Wrong split target");
        } else if (path === "worker_stop_terminal") {
          if (variant === "before") { adapter.kill("worker"); if (adapter.isAlive("worker")) throw new Error("Pane stayed live"); }
          else { await adapter.killAsync("worker"); if (await adapter.isAliveAsync("worker")) throw new Error("Pane stayed live"); }
        }
        const wallMs = performance.now() - start;
        const timerLagMs = await timer;
        samples.push({ path, round, variant, uptime, syncCalls, asyncCalls, wallMs, timerLagMs });
      });
    }
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, rounds, mode: real ? "real-readonly-status-server" : "synthetic-replies-real-child-processes", childDelayMs: real ? undefined : pauseMs, samples }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
