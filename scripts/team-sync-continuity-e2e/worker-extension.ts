import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piTeamBright from "../../extensions/index";

const captureFile = process.env.PI_TEAM_SYNC_WORKER_BOOT_CAPTURE;

export default function workerVerificationExtension(pi: ExtensionAPI): void {
  piTeamBright(pi);
  if (!captureFile || !process.env.PI_AGENT_NAME || process.env.PI_AGENT_NAME === "team-lead") return;
  pi.on("session_start", () => {
    fs.appendFileSync(captureFile, `${JSON.stringify({ pid: process.pid, argv: process.argv, execPath: process.execPath, worker: process.env.PI_AGENT_NAME })}\n`);
  });
}
