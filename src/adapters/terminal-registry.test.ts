import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeHostEnv } from "../env/host-env";
import { clearAdapterCache, getTerminalAdapter } from "./terminal-registry";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAdapterCache();
});

describe("terminal backend detection precedence", () => {
  it("selects the visible Herdr pane before inherited nested tmux identity", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_PANE_ID", "w4:p6");
    vi.stubEnv("HERDR_TAB_ID", "w4:t4");
    vi.stubEnv("TMUX", "/tmp/tmux/default,1,0");
    vi.spyOn(nodeHostEnv.exec, "run").mockResolvedValue({ kind: "exited", stdout: "status: running", stderr: "", status: 0 });

    expect((await getTerminalAdapter())?.name).toBe("herdr");
  });

  it("falls back to tmux when Herdr pane identity isn't usable", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_PANE_ID", "");
    vi.stubEnv("HERDR_TAB_ID", "w4:t4");
    vi.stubEnv("TMUX", "/tmp/tmux/default,1,0");

    expect((await getTerminalAdapter())?.name).toBe("tmux");
  });
});
