import { describe, expect, it, vi } from "vitest";
import type { TeamConfig } from "./models";
import type { TerminalAdapter } from "./terminal-adapter";
import { admitTeamSession, placeSessionTerminal } from "./session-terminal";

function adapter(name: string, currentTargetId: string | null = "surface-current", direct = true): TerminalAdapter {
  return {
    name,
    detect: vi.fn(() => true),
    currentTargetId: () => currentTargetId,
    isDirectCarrier: () => direct,
    spawn: () => "surface-worker",
    kill() {},
    isAlive: () => true,
    setTitle() {},
    supportsWindows: () => false,
    spawnWindow: () => { throw new Error("unsupported"); },
    setWindowTitle() {},
    killWindow() {},
    isWindowAlive: () => false,
  };
}

function config(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: "placement-team",
    createdAt: Date.now(),
    leadAgentId: "lead-agent",
    leadSessionId: "/tmp/lead.jsonl",
    members: [],
    ...overrides,
  } as TeamConfig;
}

describe("session terminal placement", () => {
  it("places a process that is inside the Team's own backend", () => {
    const placement = placeSessionTerminal(config({ terminalBackend: "herdr" }), adapter("herdr", "w4:p9"));

    expect(placement).toEqual({
      kind: "placed",
      update: { terminalTarget: { backend: "herdr", kind: "pane", targetId: "w4:p9" } },
    });
  });

  it("ignores inherited nested TMUX_PANE for a backend-bound Team", () => {
    const placement = placeSessionTerminal(config({ terminalBackend: "herdr" }), adapter("herdr", "w4:p9"), "%nested");

    expect(placement).toEqual({
      kind: "placed",
      update: { terminalTarget: { backend: "herdr", kind: "pane", targetId: "w4:p9" } },
    });
  });

  it("reports a bound Team as unlocated when its backend exposes no target", () => {
    expect(placeSessionTerminal(config({ terminalBackend: "herdr" }), adapter("herdr", null)))
      .toEqual({ kind: "unlocated" });
  });

  it("reports a nested carrier even when its inherited backend identity matches", () => {
    expect(placeSessionTerminal(config({ terminalBackend: "herdr" }), adapter("herdr", "w4:p9", false)))
      .toEqual({ kind: "nested", backend: "herdr" });
  });

  it("reports a foreign process, including when no backend is detected at all", () => {
    expect(placeSessionTerminal(config({ terminalBackend: "herdr" }), adapter("tmux")))
      .toEqual({ kind: "foreign", expected: "herdr", actual: "tmux" });
    expect(placeSessionTerminal(config({ terminalBackend: "herdr" }), null))
      .toEqual({ kind: "foreign", expected: "herdr", actual: null });
  });

  it("still refreshes the untyped field for a pre-binding Team running in tmux", () => {
    expect(placeSessionTerminal(config(), adapter("tmux", "%7"), "%7"))
      .toEqual({ kind: "placed", update: { tmuxPaneId: "%7" } });
  });

  it("never files a non-tmux backend's own pane ID under the untyped legacy field", () => {
    expect(placeSessionTerminal(config(), adapter("herdr", "w4:p9")))
      .toEqual({ kind: "unlocated" });
  });

  it("still accepts a tmux pane environment as legacy evidence under another backend", () => {
    expect(placeSessionTerminal(config(), adapter("herdr", "w4:p9"), "%nested"))
      .toEqual({ kind: "placed", update: { tmuxPaneId: "%nested" } });
  });
});

describe("Team session admission", () => {
  it("admits a placed process and carries exactly the update it may persist", () => {
    const placement = placeSessionTerminal(config({ terminalBackend: "herdr" }), adapter("herdr", "w4:p9"));

    expect(admitTeamSession(config({ terminalBackend: "herdr" }), "worker", placement, "launch_env")).toEqual({
      kind: "admitted",
      update: { terminalTarget: { backend: "herdr", kind: "pane", targetId: "w4:p9" } },
    });
  });

  it("admits an unlocated process without any terminal update", () => {
    expect(admitTeamSession(config({ terminalBackend: "herdr" }), "worker", { kind: "unlocated" }, "launch_env"))
      .toEqual({ kind: "admitted" });
  });

  it("closes a launcher-spawned process that cannot serve its Team", () => {
    const admission = admitTeamSession(
      config({ name: "visual-six", terminalBackend: "herdr" }),
      "visual-1",
      { kind: "foreign", expected: "herdr", actual: "tmux" },
      "launch_env",
    );

    expect(admission.kind).toBe("refused");
    if (admission.kind !== "refused") return;
    expect(admission.exitProcess).toBe(true);
    expect(admission.reason).toMatch(/bound to terminal backend herdr/i);
    expect(admission.reason).toMatch(/running in tmux/i);
    expect(admission.reason).toMatch(/relaunch this process from herdr/i);
  });

  it("closes a launcher-spawned process in a nested carrier", () => {
    const admission = admitTeamSession(
      config({ terminalBackend: "herdr" }),
      "worker",
      { kind: "nested", backend: "herdr" },
      "launch_env",
    );

    expect(admission).toMatchObject({ kind: "refused", exitProcess: true });
    if (admission.kind !== "refused") return;
    expect(admission.reason).toMatch(/nested terminal carrier/i);
    expect(admission.reason).toMatch(/directly carried by.*herdr/i);
  });

  it("leaves the operator's own resumed terminal open while still refusing to bind it", () => {
    const admission = admitTeamSession(
      config({ terminalBackend: "herdr" }),
      "team-lead",
      { kind: "foreign", expected: "herdr", actual: "tmux" },
      "resumed_session",
    );

    expect(admission.kind).toBe("refused");
    if (admission.kind !== "refused") return;
    expect(admission.exitProcess).toBe(false);
  });
});
