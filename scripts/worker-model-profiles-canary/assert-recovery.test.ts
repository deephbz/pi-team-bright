import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const retainedRoot = "/tmp/pi-team-bright-profile-e2e-20260915";
const verifier = fileURLToPath(new URL("./assert.mjs", import.meta.url));

function withFixture(mutator: (root: string) => void, expectedFailure: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-profile-proof-"));
  try {
    cpSync(retainedRoot, root, { recursive: true });
    mutator(root);
    const result = spawnSync(process.execPath, [verifier, "--raw-dir", root, "--receipt", join(root, "receipt.json")], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedFailure);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("ADR0014 recovery proof negatives", () => {
  const available = existsSync(join(retainedRoot, "receipt.json"));

  it.skipIf(!available)("rejects a model/thinking reset after recovery", () => {
    withFixture((root) => {
      const path = join(root, "evidence/worker-sessions/review.jsonl");
      const rows = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
      rows.push({ type: "model_change", timestamp: "2026-09-15T05:38:30.000Z", provider: "anthropic", modelId: "claude-haiku-4-5-20251001" });
      rows.push({ type: "thinking_level_change", timestamp: "2026-09-15T05:38:31.000Z", thinkingLevel: "medium" });
      writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    }, "failed:recovery_no_post_model_reset");
  });

  it.skipIf(!available)("rejects a successor claim before prerequisite completion", () => {
    withFixture((root) => {
      const path = join(root, "evidence/team-events.jsonl");
      const rows = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
      const completion = rows.find((row) => row.taskId === "profile-check-c" && row.transition === "goal_achieved");
      expect(completion).toBeTruthy();
      completion.at = "2026-09-15T05:38:30.000Z";
      writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    }, "failed:recovery_prerequisite_profile-check-c");
  });
});
