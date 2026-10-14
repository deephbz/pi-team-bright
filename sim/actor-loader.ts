import { vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as sharedHost from "../src/env/host-env";

/** A separate PTB module graph per simulated process; all graphs share the host dispatcher. */
export async function loadActorExtension(variables: Readonly<Record<string, string | undefined>> = {}) {
  vi.resetModules();
  const hostModule = "../src/env/host-env";
  vi.doMock(hostModule, () => sharedHost);
  // Module configuration may inspect actor variables. Runtime effects during import fail.
  const env = new Proxy({ process: { env: variables } }, {
    get(target, key) {
      if (key === "process") return target.process;
      throw new Error(`Runtime host capability during module load: ${String(key)}`);
    },
  }) as unknown as sharedHost.HostEnv;
  try { return await sharedHost.runWithHostEnv(env, async () => {
    const module = await import("../extensions/index.js");
    return module.default as unknown as (pi: ExtensionAPI) => void;
  }); }
  finally { vi.doUnmock(hostModule); }
}
