// Test-only extension. Production PTB is loaded separately by the PTY runner.
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prepareWorkload } from "./workload";

export default function fixture(pi: ExtensionAPI) {
  const out = fs.createWriteStream(process.env.PTB_TUI_EVENTS!, { flags: "a", mode: 0o600 });
  const emit = (event: string, extra = {}) => out.write(JSON.stringify({ event, at: performance.timeOrigin + performance.now(), monoMs: Number(process.hrtime.bigint()) / 1e6, ...extra }) + "\n");
  let workload: Awaited<ReturnType<typeof prepareWorkload>>;
  let unsubscribe: (() => void) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    unsubscribe?.();
    unsubscribe = ctx.ui.onTerminalInput(data => {
      if (data === "\x1b") emit("escape_input");
      return undefined;
    });
    emit("ready");
    ctx.ui.setStatus("responsiveness", "PTB_PROBE_READY");
  });
  pi.on("agent_end", () => { emit("agent_end"); });
  pi.on("session_shutdown", async () => { unsubscribe?.(); await workload?.close(); out.end(); });
  pi.registerCommand("probe-prepare", {
    description: "Prepare disposable real-authority workload",
    handler: async (_args, ctx) => {
      workload = await prepareWorkload();
      emit("prepared");
      ctx.ui.notify("PTB_PROBE_PREPARED");
    },
  });
  pi.registerTool({
    name: "responsiveness_probe", label: "Responsiveness fixture", description: "Run a bounded test workload",
    parameters: Type.Object({ mode: Type.String() }),
    async execute(_id, { mode }, signal) {
      emit("work_start", { mode });
      const aborted = () => emit("abort_signal", { mode });
      signal?.addEventListener("abort", aborted, { once: true });
      const start = performance.now();
      let iterations = 0;
      try {
        // Give the driver a deterministic window to queue input DURING the block.
        if (mode === "block") {
          await new Promise(r => setTimeout(r, 150));
          emit("block_start");
          const until = performance.now() + 700;
          while (performance.now() < until) { /* deliberate positive control */ }
          await new Promise(r => setTimeout(r, 500));
        } else if (mode === "async") {
          // Deliberately non-cancellable: dispatch and tool completion differ.
          await new Promise(r => setTimeout(r, 2000));
        } else if (mode === "coordination") {
          if (!workload) throw new Error("Run /probe-prepare first");
          while (performance.now() - start < 2000) {
            await workload.runOnce();
            iterations++;
          }
        } else throw new Error(`Unknown fixture mode: ${mode}`);
      } finally {
        signal?.removeEventListener("abort", aborted);
        emit("work_end", { mode, iterations, wallMs: performance.now() - start });
      }
      return { content: [{ type: "text", text: "Fixture complete" }], details: { mode, iterations } };
    },
  });
}
