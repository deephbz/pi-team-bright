import { hostEnv } from "../src/env/host-env";
import { MISSING_GENERATION_HELPER_MESSAGE } from "../src/env/process-generation";

/** One human-only helper diagnostic per extension load. No Session history or model turn. */
export function createProcessGenerationWarning() {
  let checked = false;
  return (ctx: { hasUI?: boolean; ui?: { notify?: (message: string, severity: "warning") => void } }): void => {
    if (checked) return;
    checked = true;
    try {
      const hostProcess = hostEnv().process;
      if (hostProcess.platform !== "darwin") return;
      const probe = hostProcess.generation(hostProcess.pid);
      if (probe.kind !== "unknown" || probe.reason !== "generation_helper_missing") return;
    } catch { return; }
    const message = `Pi Team Bright: ${MISSING_GENERATION_HELPER_MESSAGE}`;
    if (ctx.hasUI !== false && ctx.ui?.notify) {
      try { ctx.ui.notify(message, "warning"); return; }
      catch { /* Native UI failure falls back to stderr. */ }
    }
    try { process.stderr.write(`${message}\n`); }
    catch { /* A diagnostic cannot fail startup. */ }
  };
}
