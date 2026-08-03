import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "./paths";
import { createTeam } from "./teams";
import {
  commitHiddenObservationProjection,
  readHiddenObservationProjection,
} from "./hidden-observation";

const roots: string[] = [];

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-hidden-observation-"));
  roots.push(directory);
  const configFile = path.join(directory, "config.json");
  vi.spyOn(paths, "teamDir").mockReturnValue(directory);
  vi.spyOn(paths, "configPath").mockReturnValue(configFile);
  vi.spyOn(paths, "taskDir").mockReturnValue(path.join(directory, "tasks"));
  return { directory, configFile };
}

function observationFile(directory: string, epochId: string, exactSessionId: string): string {
  const epochKey = crypto.createHash("sha256").update(epochId).digest("hex");
  const sessionKey = crypto.createHash("sha256").update(exactSessionId).digest("hex");
  return path.join(directory, "hidden-observations", epochKey, `${sessionKey}.json`);
}

describe("hidden observation projection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("commits mode-0600 state and reads it only on the acknowledged Session lineage", async () => {
    const { directory } = fixture();
    const leadSession = "/tmp/hidden-observation-lead.jsonl";
    const team = await createTeam("hidden-team", leadSession, "lead");
    const projectionFile = observationFile(directory, team.epochId!, leadSession);
    const coordinate = {
      teamEpochId: team.epochId!,
      exactSessionId: leadSession,
      branchLineage: ["root", "tool-result", "assistant"],
    };

    const committed = await commitHiddenObservationProjection("hidden-team", {
      ...coordinate,
      acknowledgedEntryId: "tool-result",
      teamEventCursor: "7",
      authorityRevisions: { tasks: "revision-9" },
    });
    expect(committed).toMatchObject({
      kind: "committed",
      projection: {
        teamEpochId: team.epochId,
        exactSessionId: leadSession,
        acknowledgedEntryId: "tool-result",
        acknowledgedLineage: ["root", "tool-result"],
        teamEventCursor: "7",
      },
    });
    expect(fs.statSync(projectionFile).mode & 0o7777).toBe(0o600);

    await expect(readHiddenObservationProjection("hidden-team", {
      ...coordinate,
      branchLineage: [...coordinate.branchLineage, "next-turn"],
    })).resolves.toMatchObject({ kind: "found", projection: { teamEventCursor: "7" } });
    await expect(readHiddenObservationProjection("hidden-team", {
      ...coordinate,
      branchLineage: ["root", "different-result"],
    })).resolves.toEqual({ kind: "not_found", reason: "lineage_mismatch" });
    await expect(readHiddenObservationProjection("hidden-team", {
      ...coordinate,
      exactSessionId: "/tmp/other-session.jsonl",
    })).resolves.toEqual({ kind: "coordinate_mismatch", reason: "lead_session_mismatch" });
    await expect(readHiddenObservationProjection("hidden-team", {
      ...coordinate,
      teamEpochId: "team_epoch_other",
    })).resolves.toEqual({ kind: "coordinate_mismatch", reason: "team_epoch_mismatch" });
  });

  it("serializes acknowledgements, refuses regression/conflict, and permits a new acknowledged branch", async () => {
    fixture();
    const leadSession = "/tmp/hidden-observation-serial.jsonl";
    const team = await createTeam("hidden-team", leadSession, "lead");
    const base = { teamEpochId: team.epochId!, exactSessionId: leadSession };

    await expect(commitHiddenObservationProjection("hidden-team", {
      ...base,
      branchLineage: ["root", "first"],
      acknowledgedEntryId: "first",
      teamEventCursor: "1",
    })).resolves.toMatchObject({ kind: "committed" });
    await expect(commitHiddenObservationProjection("hidden-team", {
      ...base,
      branchLineage: ["root", "first", "second"],
      acknowledgedEntryId: "second",
      teamEventCursor: "2",
    })).resolves.toMatchObject({ kind: "committed" });
    await expect(commitHiddenObservationProjection("hidden-team", {
      ...base,
      branchLineage: ["root", "first"],
      acknowledgedEntryId: "first",
      teamEventCursor: "1",
    })).resolves.toEqual({ kind: "refused", reason: "stale_acknowledgement" });
    await expect(commitHiddenObservationProjection("hidden-team", {
      ...base,
      branchLineage: ["root", "first", "second"],
      acknowledgedEntryId: "second",
      teamEventCursor: "3",
    })).resolves.toEqual({ kind: "refused", reason: "acknowledgement_conflict" });
    await expect(commitHiddenObservationProjection("hidden-team", {
      ...base,
      branchLineage: ["root", "alternate"],
      acknowledgedEntryId: "alternate",
      teamEventCursor: "4",
    })).resolves.toMatchObject({ kind: "committed", projection: { acknowledgedEntryId: "alternate" } });
  });

  it("preserves the old projection on atomic rename failure and repairs unsafe modes on success", async () => {
    const { directory } = fixture();
    const leadSession = "/tmp/hidden-observation-atomic.jsonl";
    const team = await createTeam("hidden-team", leadSession, "lead");
    const projectionFile = observationFile(directory, team.epochId!, leadSession);
    const base = { teamEpochId: team.epochId!, exactSessionId: leadSession };
    await commitHiddenObservationProjection("hidden-team", {
      ...base,
      branchLineage: ["root", "first"],
      acknowledgedEntryId: "first",
      teamEventCursor: "1",
    });
    fs.chmodSync(projectionFile, 0o644);
    const before = fs.readFileSync(projectionFile, "utf8");
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated observation rename failure");
    });

    await expect(commitHiddenObservationProjection("hidden-team", {
      ...base,
      branchLineage: ["root", "first", "second"],
      acknowledgedEntryId: "second",
      teamEventCursor: "2",
    })).rejects.toThrow("simulated observation rename failure");
    expect(fs.readFileSync(projectionFile, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(projectionFile)).some((name) => name.endsWith(".tmp"))).toBe(false);

    rename.mockRestore();
    await commitHiddenObservationProjection("hidden-team", {
      ...base,
      branchLineage: ["root", "first", "second"],
      acknowledgedEntryId: "second",
      teamEventCursor: "2",
    });
    expect(fs.statSync(projectionFile).mode & 0o7777).toBe(0o600);
  });

  it("returns a typed legacy contract gap without creating projection state", async () => {
    const { directory, configFile } = fixture();
    const leadSession = "/tmp/hidden-observation-legacy.jsonl";
    await createTeam("hidden-team", leadSession, "lead");
    const current = JSON.parse(fs.readFileSync(configFile, "utf8"));
    delete current.epochId;
    delete current.logicalWorkers;
    fs.writeFileSync(configFile, JSON.stringify(current, null, 2));

    await expect(commitHiddenObservationProjection("hidden-team", {
      teamEpochId: "unknown",
      exactSessionId: leadSession,
      branchLineage: ["root", "result"],
      acknowledgedEntryId: "result",
      teamEventCursor: "0",
    })).resolves.toEqual({ kind: "contract_gap", reason: "team_epoch_missing" });
    expect(fs.existsSync(path.join(directory, "hidden-observations"))).toBe(false);
  });
});
