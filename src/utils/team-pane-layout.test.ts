import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TEAM_PANE_LAYOUT,
  loadTeamPaneLayoutSettings,
  resolveTeamPaneLayout,
} from "./team-pane-layout";

const roots: string[] = [];

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-pane-layout-"));
  roots.push(directory);
  return directory;
}

function settings(file: string, paneLayout: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pi_team_bright: { team: { pane_layout: paneLayout } } }));
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Team pane layout policy", () => {
  it("resolves explicit, trusted project, global, then default precedence", () => {
    const directory = root();
    const agentDir = path.join(directory, "agent");
    settings(path.join(directory, ".pi", "settings.json"), { leader_share: 0.7, worker_tiling: "grid" });
    settings(path.join(agentDir, "settings.json"), { leader_share: 0.8, worker_tiling: "linear" });

    const loaded = loadTeamPaneLayoutSettings({ cwd: directory, projectTrusted: true, agentDir });
    expect(resolveTeamPaneLayout({ ...loaded, backend: "herdr" })).toEqual({ leader_share: 0.7, worker_tiling: "grid" });
    expect(resolveTeamPaneLayout({ explicit: { leader_share: 0.9, worker_tiling: "linear" }, ...loaded, backend: "tmux" }))
      .toEqual({ leader_share: 0.9, worker_tiling: "linear" });
    expect(resolveTeamPaneLayout({ global: loaded.global, backend: "tmux" }))
      .toEqual({ leader_share: 0.8, worker_tiling: "linear" });
    expect(resolveTeamPaneLayout({ backend: "tmux" })).toEqual(DEFAULT_TEAM_PANE_LAYOUT);
  });

  it("ignores project settings without a trusted project context", () => {
    const directory = root();
    const agentDir = path.join(directory, "agent");
    settings(path.join(directory, ".pi", "settings.json"), { leader_share: 0.7, worker_tiling: "grid" });
    settings(path.join(agentDir, "settings.json"), { leader_share: 0.8, worker_tiling: "linear" });

    const loaded = loadTeamPaneLayoutSettings({ cwd: directory, projectTrusted: false, agentDir });
    expect(loaded.project).toBeUndefined();
    expect(resolveTeamPaneLayout({ ...loaded, backend: "tmux" })).toEqual({ leader_share: 0.8, worker_tiling: "linear" });
  });

  it("refuses invalid and unsupported policies before creation", () => {
    expect(() => resolveTeamPaneLayout({ explicit: { leader_share: 0.59, worker_tiling: "linear" }, backend: "tmux" }))
      .toThrow(/Invalid pane_layout/);
    expect(() => resolveTeamPaneLayout({ explicit: { leader_share: 0.6, worker_tiling: "grid" }, backend: "tmux" }))
      .toThrow(/unsupported.*tmux/i);
    expect(() => resolveTeamPaneLayout({ explicit: { leader_share: 0.995, worker_tiling: "linear" }, backend: "tmux" }))
      .toThrow(/no Worker pane.*0.99/i);
    expect(() => resolveTeamPaneLayout({ explicit: { leader_share: 0.6, worker_tiling: "diagonal" }, backend: "herdr" }))
      .toThrow(/Invalid pane_layout/);
  });
});
