import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SYNC_NUDGE_DELAY_SECONDS, DEFAULT_SYNC_WAIT_SECONDS, loadSyncLivenessSettings } from "./sync-liveness-settings";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function settings(value: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-liveness-settings-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify(value));
  return root;
}

describe("sync liveness settings", () => {
  it("uses the wait and enabled nudge defaults when settings are omitted", () => {
    const policy = loadSyncLivenessSettings({ agentDir: settings({}) });
    expect(policy.waitSeconds).toBe(DEFAULT_SYNC_WAIT_SECONDS);
    expect(policy.nudgeEnabled).toBe(true);
    expect(policy.nudgeDelaySeconds).toBe(DEFAULT_SYNC_NUDGE_DELAY_SECONDS);
    expect(policy.diagnostics.join(" ")).toMatch(/default true/);
    expect(policy.diagnostics.join(" ")).toMatch(/default 1200 seconds/);
  });

  it("reads the global Team policy and rejects malformed values", () => {
    const policy = loadSyncLivenessSettings({ agentDir: settings({ pi_team_bright: { team: { wait_seconds: 30, nudge_enabled: true, nudge_delay_seconds: 5 } } }) });
    expect(policy).toMatchObject({ waitSeconds: 30, nudgeEnabled: true, nudgeDelaySeconds: 5 });
    const malformed = loadSyncLivenessSettings({ agentDir: settings({ pi_team_bright: { team: { wait_seconds: -1, nudge_enabled: "yes", nudge_delay_seconds: -2 } } }) });
    expect(malformed).toMatchObject({ waitSeconds: 120, nudgeEnabled: true, nudgeDelaySeconds: DEFAULT_SYNC_NUDGE_DELAY_SECONDS });
    expect(malformed.diagnostics.length).toBeGreaterThanOrEqual(3);
    const disabled = loadSyncLivenessSettings({ agentDir: settings({ pi_team_bright: { team: { nudge_enabled: false } } }) });
    expect(disabled).toMatchObject({ nudgeEnabled: false, nudgeDelaySeconds: DEFAULT_SYNC_NUDGE_DELAY_SECONDS });
  });
});
