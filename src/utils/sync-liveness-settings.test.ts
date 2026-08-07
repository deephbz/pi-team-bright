import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SYNC_WAIT_SECONDS, loadSyncLivenessSettings } from "./sync-liveness-settings";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function settings(value: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-liveness-settings-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify(value));
  return root;
}

describe("sync liveness settings", () => {
  it("uses the 120 second wait and 1200 second enabled nudge defaults", () => {
    const policy = loadSyncLivenessSettings({ agentDir: settings({}) });
    expect(policy.waitSeconds).toBe(DEFAULT_SYNC_WAIT_SECONDS);
    expect(policy.nudgeEnabled).toBe(true);
    expect(policy.nudgeDelaySeconds).toBe(1_200);
    expect(policy.diagnostics.join(" ")).toMatch(/nudge_enabled/);
    expect(policy.diagnostics.join(" ")).toMatch(/1200/);
  });

  it("reads the global Team policy and rejects malformed values", () => {
    const policy = loadSyncLivenessSettings({ agentDir: settings({ pi_team_bright: { team: { wait_seconds: 30, nudge_enabled: true, nudge_delay_seconds: 5 } } }) });
    expect(policy).toMatchObject({ waitSeconds: 30, nudgeEnabled: true, nudgeDelaySeconds: 5 });
    const malformed = loadSyncLivenessSettings({ agentDir: settings({ pi_team_bright: { team: { wait_seconds: -1, nudge_enabled: "yes", nudge_delay_seconds: -2 } } }) });
    expect(malformed).toMatchObject({ waitSeconds: 120, nudgeEnabled: true, nudgeDelaySeconds: 1_200 });
    expect(malformed.diagnostics.length).toBeGreaterThanOrEqual(3);
  });
});
