import { vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as sharedHost from "../src/env/host-env";

/** A separate PTB module graph per simulated process; all graphs share the host dispatcher. */
export async function loadActorExtension() {
  vi.resetModules();
  vi.doMock("../src/env/host-env", () => sharedHost);
  try { return (await import("../extensions/index.js")).default as unknown as (pi: ExtensionAPI) => void; }
  finally { vi.doUnmock("../src/env/host-env"); }
}
