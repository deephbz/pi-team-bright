// Probe instrumentation only. No PTB binding, tools, credentials, or remote calls.
import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const log = (record: object) => fs.appendFileSync(process.env.PROBE_LOG!, JSON.stringify({ at: Date.now(), pid: process.pid, ...record }) + "\n");
  const snapshot = (ctx: ExtensionContext) => ({ branch: ctx.sessionManager.getBranch(), contextEntries: ctx.sessionManager.buildContextEntries() });
  pi.on("session_start", (event) => {
    log({ event: "session_start", reason: event.reason });
    process.once("exit", (code) => log({ event: "process_exit", code }));
  });
  pi.on("session_shutdown", (event) => log({ event: "session_shutdown", ...event }));
  pi.on("before_provider_request", () => {
    if (process.env.PROBE_ALLOW_LOCAL !== "1") throw new Error("Model requests forbidden in terminal probes");
  });
  pi.registerCommand("probe-followup", {
    handler: async (_args, ctx) => {
      const idleBefore = ctx.isIdle();
      pi.sendMessage({ customType: "probe-followup", content: "PROBE_FOLLOWUP_SENTINEL", display: false }, { deliverAs: "followUp", triggerTurn: true });
      log({ event: "followup_queued", idleBefore, pendingAfter: ctx.hasPendingMessages(), ...snapshot(ctx) });
    },
  });
  pi.registerCommand("probe-snapshot", {
    handler: async (_args, ctx) => { log({ event: "snapshot", ...snapshot(ctx) }); },
  });
  pi.on("session_before_compact", (event, ctx) => {
    log({ event: "before_compact", ...snapshot(ctx) });
    return { compaction: { summary: "PROBE_STATIC_SUMMARY", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  });
  pi.on("session_compact", (event, ctx) => log({ event: "after_compact", compactionEntry: event.compactionEntry, ...snapshot(ctx) }));
}
