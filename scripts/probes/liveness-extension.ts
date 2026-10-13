// Real PTB composition with payload-light lifecycle evidence for the isolated D5 run.
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ptb from "../../extensions/index";
export default function (pi: ExtensionAPI) {
  ptb(pi);
  for (const event of ["session_start", "session_shutdown"] as const) {
    pi.on(event, (data, ctx) => {
      fs.appendFileSync(process.env.PI_PROBE_LOG!, JSON.stringify({ at: Date.now(), pid: process.pid,
        worker: process.env.PI_AGENT_NAME ?? "team-lead", event, reason: data.reason,
        sessionFile: ctx.sessionManager.getSessionFile() }) + "\n");
    });
  }
}
