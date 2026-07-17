import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const repo = path.resolve(import.meta.dirname, "../..");
const forbiddenKeys = new Set(["sourceRoot", "path", "session", "entryId", "toolCallId", "timestamp"]);

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

describe("public QA history projections", () => {
  test("checked-in coverage catalog contains semantic derivation only", () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "historical-scenarios.json"), "utf8"));
    const leakedKeys = [...collectKeys(catalog)].filter((key) => forbiddenKeys.has(key));
    expect(leakedKeys).toEqual([]);
    expect(catalog.scenarios.every((scenario: any) =>
      ["direct-observation", "legacy-analog", "synthetic-gap"].includes(scenario.provenance?.basis)
    )).toBe(true);
  });

  test("miner keeps private locators transient while emitting aggregates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "PRIVATE_USER_SENTINEL-"));
    const sessionFile = path.join(root, "PRIVATE_SESSION_SENTINEL.jsonl");
    const output = path.join(root, "catalog.json");
    fs.writeFileSync(sessionFile, `${JSON.stringify({
      id: "PRIVATE_ENTRY_SENTINEL",
      timestamp: "PRIVATE_TIME_SENTINEL",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "team_create",
        toolCallId: "PRIVATE_CALL_SENTINEL",
        content: [{ type: "text", text: "Created Team example." }],
        details: { outcome: "accepted" },
      },
    })}\n`);

    const result = spawnSync(process.execPath, [
      "-r", "ts-node/register/transpile-only",
      path.join(import.meta.dirname, "mine-history.ts"),
    ], {
      cwd: repo,
      env: { ...process.env, PI_TEAMS_SESSION_ROOT: root, PI_TEAMS_QA_HISTORY_OUTPUT: output },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);

    const text = fs.readFileSync(output, "utf8");
    expect(text).not.toMatch(/PRIVATE_(?:USER|SESSION|ENTRY|TIME|CALL)_SENTINEL/);
    const catalog = JSON.parse(text);
    expect([...collectKeys(catalog)].filter((key) => forbiddenKeys.has(key))).toEqual([]);
    expect(catalog.observationCounts).toMatchObject({ matching: 1, unique: 1, forkDuplicatesIgnored: 0 });
    expect(catalog.summary.byCurrentTool.team_create).toBe(1);
  });
});
