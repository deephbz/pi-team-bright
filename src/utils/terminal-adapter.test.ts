import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TmuxAdapter } from "../adapters/tmux-adapter";
import * as terminal from "./terminal-adapter";

describe("structured terminal launch security", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes a model marker as one argv value and never executes it", () => {
    const marker = path.join(os.tmpdir(), `pi-teams-model-marker-${process.pid}`);
    fs.rmSync(marker, { force: true });
    process.env.TMUX = "/tmp/pi-teams-test/default,1,0";
    process.env.TMUX_PANE = "%1";
    const exec = vi.spyOn(terminal, "execCommand").mockImplementation((_bin, args) => {
      if (args[0] === "display-message" && args[4] === "#{pane_id}") return { stdout: args[3], stderr: "", status: 0 };
      if (args[0] === "display-message" && args[4] === "#{window_id}") return { stdout: "@1", stderr: "", status: 0 };
      if (args[0] === "split-window") {
        const shell = args[args.length - 1];
        spawnSync(process.env.SHELL || "sh", ["-c", shell], { stdio: "ignore" });
        return { stdout: "%2", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    });

    const maliciousModel = `x; touch ${marker}; #`;
    new TmuxAdapter().spawn({
      name: "worker",
      cwd: os.tmpdir(),
      argv: [process.execPath, "-e", "", "--model", maliciousModel],
      env: { PI_AGENT_NAME: "worker" },
    });

    expect(fs.existsSync(marker)).toBe(false);
    const split = exec.mock.calls.find(([, args]) => args[0] === "split-window")?.[1];
    expect(split?.at(-1)).toContain(`'${maliciousModel.replace(/'/g, `'\\''`)}'`);
    fs.rmSync(marker, { force: true });
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });
});
