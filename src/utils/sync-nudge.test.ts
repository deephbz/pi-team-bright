import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSyncNudgeRecord, presentSyncNudge, readSyncNudgeRecords, readSyncNudges, reserveSyncNudge, syncNudgeContent, syncNudgeTuiLine } from "./sync-nudge";
import { syncNudgeRecordPath, teamDir } from "./paths";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function record(kind: "reserved" | "presented" = "presented") {
  return createSyncNudgeRecord({
    kind,
    id: "nudge-1", teamName: `nudge-test-${process.pid}`, teamEpochId: "epoch-1", leaderSessionId: "session-1", leaderMembershipId: "membership-1",
    branchLineage: ["root", "branch-1"], branchId: "branch-1", debtKey: "debt-1", requestedView: "updates", reservedAt: new Date().toISOString(),
    ...(kind === "presented" ? { presentedAt: new Date().toISOString() } : {}), policyVersion: "1",
  });
}

describe("sync nudge derived presentation", () => {
  it("reconciles a reserved record only after the Session custom message exists", () => {
    const team = `nudge-test-${process.pid}`;
    fs.rmSync(teamDir(team), { recursive: true, force: true });
    fs.mkdirSync(teamDir(team), { recursive: true });
    roots.push(teamDir(team));
    const reserved = record("reserved");
    reserveSyncNudge(reserved);
    expect(readSyncNudges(team)).toEqual([]);
    presentSyncNudge(reserved, new Date().toISOString());
    expect(readSyncNudgeRecords(team)).toHaveLength(1);
    expect(readSyncNudges(team)).toHaveLength(1);
    expect(syncNudgeContent(reserved)).not.toContain("task-");
    expect(syncNudgeTuiLine(reserved)).toContain("pending");
    expect(syncNudgeTuiLine(readSyncNudges(team)[0])).toContain("presented");
  });

  it("uses the latest valid record by ID and ignores malformed or foreign receipt history", () => {
    const team = `nudge-history-${process.pid}`;
    fs.rmSync(teamDir(team), { recursive: true, force: true });
    fs.mkdirSync(teamDir(team), { recursive: true });
    roots.push(teamDir(team));
    const reserved = createSyncNudgeRecord({ ...record("reserved"), teamName: team });
    reserveSyncNudge(reserved);
    fs.appendFileSync(syncNudgeRecordPath(team), "not-json\n");
    fs.appendFileSync(syncNudgeRecordPath(team), `${JSON.stringify({ ...reserved, teamName: "foreign-team" })}\n`);
    const promoted = presentSyncNudge(reserved, "2026-08-10T00:00:00.000Z");

    expect(readSyncNudgeRecords(team)).toEqual([promoted]);
    expect(readSyncNudges(team)).toEqual([promoted]);
  });
});
