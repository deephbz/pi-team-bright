import { vi } from "vitest";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as sharedHost from "../src/env/host-env";

/** A separate PTB module graph per simulated process; all graphs share the host dispatcher. */
export async function loadActorExtension(variables: Readonly<Record<string, string | undefined>> = {}, sourceRoot?: string) {
  vi.resetModules();
  const hostModule = sourceRoot ? path.join(sourceRoot, "src/env/host-env.ts") : "../src/env/host-env";
  vi.doMock(hostModule, () => sharedHost);
  // Module configuration may inspect actor variables. Runtime effects during import fail.
  const env = new Proxy({ process: { env: variables } }, {
    get(target, key) {
      if (key === "process") return target.process;
      throw new Error(`Runtime host capability during module load: ${String(key)}`);
    },
  }) as unknown as sharedHost.HostEnv;
  try { return await sharedHost.runWithHostEnv(env, async () => {
    const beads: typeof import("../src/utils/beads.js") = sourceRoot ? await import(path.join(sourceRoot, "src/utils/beads.ts")) : await import("../src/utils/beads.js");
    // Only the external CLI transport changes. BeadsTaskStore and provisioning stay real.
    beads.ExecBdRunner.prototype.run = async (args, options) => {
      const argv = args.includes("--directory") ? args : ["--directory", options.cwd, ...args];
      const outcome = await sharedHost.hostEnv().exec.run("bd", argv, { timeoutMs: options.timeoutMs });
      if (outcome.kind === "exited") return { stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.status ?? 1 };
      return { stdout: "", stderr: outcome.kind, exitCode: outcome.kind === "spawn_failed" ? 127 : 124 };
    };
    const module = sourceRoot ? await import(path.join(sourceRoot, "extensions/index.ts")) : await import("../extensions/index.js");
    return module.default as unknown as (pi: ExtensionAPI) => void;
  }); }
  finally { vi.doUnmock(hostModule); }
}
