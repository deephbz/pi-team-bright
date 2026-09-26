import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_SYNC_DELAY_SECONDS, DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD,
  DEFAULT_SYNC_WAIT_SECONDS, loadSyncLivenessSettings,
} from "./sync-liveness-settings";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function settings(value: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-liveness-settings-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify(value));
  return root;
}

function team(value: Record<string, unknown>) {
  return settings({ pi_team_bright: { team: value } });
}

describe("sync liveness settings", () => {
  it("uses quiet defaults when optional settings are absent", () => {
    const policy = loadSyncLivenessSettings({ agentDir: settings({}) });
    expect(policy).toMatchObject({
      waitSeconds: DEFAULT_SYNC_WAIT_SECONDS,
      autoSyncEnabled: true,
      autoSyncDelaySeconds: DEFAULT_AUTO_SYNC_DELAY_SECONDS,
      autoSyncUpdateThreshold: DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD,
      diagnostics: [],
    });
  });

  it("reads the global automatic sync policy for one Team epoch", () => {
    const policy = loadSyncLivenessSettings({ agentDir: team({
      wait_seconds: 30, auto_sync_enabled: true, auto_sync_delay_seconds: 0.2, auto_sync_update_threshold: 2,
    }) });
    expect(policy).toMatchObject({ waitSeconds: 30, autoSyncEnabled: true, autoSyncDelaySeconds: 0.2, autoSyncUpdateThreshold: 2, diagnostics: [] });
  });

  it("preserves a legacy explicit disable and delay until replacement fields appear", () => {
    const old = loadSyncLivenessSettings({ agentDir: team({ nudge_enabled: false, nudge_delay_seconds: 17 }) });
    expect(old).toMatchObject({ autoSyncEnabled: false, autoSyncDelaySeconds: 17, autoSyncUpdateThreshold: DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD });
    expect(old.diagnostics.join(" ")).toMatch(/nudge_enabled.*deprecated.*auto_sync_enabled/);
    expect(old.diagnostics.join(" ")).toMatch(/nudge_delay_seconds.*deprecated.*auto_sync_delay_seconds/);
    const replaced = loadSyncLivenessSettings({ agentDir: team({
      nudge_enabled: false, nudge_delay_seconds: 17, auto_sync_enabled: true, auto_sync_delay_seconds: 0,
    }) });
    expect(replaced).toMatchObject({ autoSyncEnabled: true, autoSyncDelaySeconds: 0 });
    expect(replaced.diagnostics.join(" ")).toMatch(/new value takes precedence/);
  });

  it("rejects invalid selected fields without using stale aliases", () => {
    const policy = loadSyncLivenessSettings({ agentDir: team({
      wait_seconds: -1, nudge_enabled: false, nudge_delay_seconds: 17,
      auto_sync_enabled: "yes", auto_sync_delay_seconds: -2, auto_sync_update_threshold: 0,
    }) });
    expect(policy).toMatchObject({
      waitSeconds: DEFAULT_SYNC_WAIT_SECONDS,
      autoSyncEnabled: true,
      autoSyncDelaySeconds: DEFAULT_AUTO_SYNC_DELAY_SECONDS,
      autoSyncUpdateThreshold: DEFAULT_AUTO_SYNC_UPDATE_THRESHOLD,
    });
    expect(policy.diagnostics.join(" ")).toMatch(/auto_sync_enabled must be boolean/);
    expect(policy.diagnostics.join(" ")).toMatch(/auto_sync_update_threshold must be an integer/);
  });
});
