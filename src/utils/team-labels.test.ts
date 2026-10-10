import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { datePrefixedTeamName, loadTeamDatePrefix, teamSessionName, teamTerminalTitle } from "./team-labels";
import { validatePtbSettingsNamespace } from "./model-role-settings";

describe("Team identity labels", () => {
  it("prefixes the local calendar date once and honors opt-out", () => {
    const date = new Date(2026, 0, 2, 23, 59);
    expect(datePrefixedTeamName("review", true, date)).toBe("20260102-review");
    expect(datePrefixedTeamName("20250101-review", true, date)).toBe("20250101-review");
    expect(datePrefixedTeamName("review", false, date)).toBe("review");
    expect(() => datePrefixedTeamName("x".repeat(56), true, date)).toThrow("exceeds 64");
    expect(datePrefixedTeamName("x".repeat(64), false, date)).toHaveLength(64);
  });

  it("loads the global policy and explicitly rejects non-boolean values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ptb-labels-"));
    try {
      expect(loadTeamDatePrefix(dir)).toBe(true);
      const file = path.join(dir, "settings.json");
      fs.writeFileSync(file, JSON.stringify({ pi_team_bright: { team: { date_prefix: false } } }));
      expect(loadTeamDatePrefix(dir)).toBe(false);
      fs.writeFileSync(file, JSON.stringify({ pi_team_bright: { team: { date_prefix: "false" } } }));
      expect(() => loadTeamDatePrefix(dir)).toThrow("must be boolean");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("validates editor scope and keeps Worker names unchanged", () => {
    expect(teamSessionName("20260102-review", "team-lead")).toBeUndefined();
    expect(teamSessionName("20260102-review", "builder")).toBe("20260102-review/builder");
    expect(teamTerminalTitle("20260102-review", "team-lead")).toBe("leader-20260102-review");
    expect(teamTerminalTitle("20260102-review", "builder")).toBe("builder");
    const namespace = { team: { date_prefix: false } };
    expect(validatePtbSettingsNamespace(namespace, { source: "global", file: "settings.json" })).toEqual([]);
    expect(validatePtbSettingsNamespace(namespace, { source: "project", file: "settings.json" })[0].message).toContain("global-only");
  });
});
