import type { TerminalAdapter } from "../src/utils/terminal-adapter";

export function terminalFixture(overrides: Partial<TerminalAdapter> = {}): TerminalAdapter {
  return {
    name: "fixture", currentTargetId: () => "leader-pane", isDirectCarrier: () => true,
    detect: async () => true, renamePane: async () => {},
    prepareSpawn: async () => "worker-pane", prepareWindow: async () => { throw new Error("unsupported"); },
    startPrepared: async () => ({ state: "started", fact: "fixture_start" }),
    kill: async () => {}, isAlive: async () => false, setTitle: () => {},
    supportsWindows: () => false, killWindow: async () => {}, isWindowAlive: async () => false,
    ...overrides,
  };
}
