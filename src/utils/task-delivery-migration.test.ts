import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import type { TaskCard } from "../model-tool-contract/task-domain";
import { configPath, taskDeliveryPath, teamDir, teamEventJournalPath } from "./paths";
import { migrateLegacyTaskDeliveryEpoch } from "./task-delivery-migration";
import { listTaskIds } from "../model-tool-contract/beads-authority-adapter";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";

vi.mock("../model-tool-contract/beads-authority-adapter", () => ({
  listTaskIds: vi.fn(),
}));
const readManyMock = vi.fn(async (ids: readonly string[]) => ids.map((id) => ({ kind: "found" as const, task: card(id) })));
vi.mock("../model-tool-contract/beads-task-adapter", () => ({
  BeadsTaskAdapter: class {
    readMany = readManyMock;
  },
}));

const listTaskIdsMock = vi.mocked(listTaskIds);
const team = `delivery-migration-${process.pid}`;

function card(id: string): TaskCard {
  return {
    id,
    title: "Canonical Task",
    goal: "Keep the migrated Task executable.",
    current_context: "Migration is ready.",
    status: "open",
    version: taskVersionRef("current-authority-version"),
  };
}

function stoppedConfig(): void {
  fs.mkdirSync(teamDir(team), { recursive: true });
  fs.writeFileSync(configPath(team), JSON.stringify({
    name: team,
    members: [],
    taskBackend: "beads",
    taskWorkspace: "/tmp/migration-beads",
    taskAuthorityId: "authority",
    taskAuthorityFingerprint: {
      schema: "pi-teams-beads-authority/1",
      backend: "dolt",
      database: "dolt",
      doltDatabase: "migration",
      projectId: "migration",
    },
  }));
}

function writeJournal(values: unknown[]): void {
  fs.mkdirSync(teamDir(team), { recursive: true });
  fs.mkdirSync(teamEventJournalPath(team).replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(teamEventJournalPath(team), `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

afterEach(() => fs.rmSync(teamDir(team), { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(teamDir(team), { recursive: true, force: true });
  listTaskIdsMock.mockReset();
  listTaskIdsMock.mockResolvedValue(["task-1"]);
  readManyMock.mockClear();
  vi.clearAllMocks();
});

describe("stopped-epoch Task delivery migration", () => {
  it("migrates mixed history without changing Worker evidence or surrounding evidence", async () => {
    stoppedConfig();
    const worker = {
      type: "worker",
      cursor: "1",
      worker: "worker",
      membershipId: "membership-1",
      phase: "session_bound",
      generation: { membershipId: "membership-1", pid: 42, startedAt: 10 },
      at: "2026-08-05T00:00:00.000Z",
    };
    const task = {
      type: "task",
      cursor: "2",
      ref: { authorityId: "authority", nativeId: "task-1", version: "raw-v2", evidence: "keep-task-ref-evidence" },
      change: "design",
      actor: "lead",
      taskEvidence: { kind: "decision", text: "Keep this evidence." },
      at: "2026-08-05T00:00:01.000Z",
    };
    const alert = {
      type: "alert",
      cursor: "3",
      alertId: "alert-1",
      from: "lead",
      to: "worker",
      taskRef: { authorityId: "authority", nativeId: "task-1", version: "raw-v2", evidence: "keep-alert-ref-evidence" },
      kind: "attention",
      text: "Review the Task.",
      at: "2026-08-05T00:00:02.000Z",
    };
    writeJournal([worker, task, alert]);
    const originalWorkerLine = fs.readFileSync(teamEventJournalPath(team), "utf8").split("\n")[0];
    const deliveryFile = taskDeliveryPath(team, "worker");
    fs.mkdirSync(teamDir(team), { recursive: true });
    fs.mkdirSync(deliveryFile.replace(/\/[^/]+$/, ""), { recursive: true });
    fs.writeFileSync(deliveryFile, JSON.stringify([{
      deliveryId: "delivery-1",
      ref: { kind: "task", authorityId: "authority", nativeId: "task-1", version: "raw-v2", evidence: "keep-delivery-ref-evidence" },
      taskSnapshot: { id: "task-1", version: "raw-v2", legacy: "preserved-by-card" },
    }]));

    const receipt = await migrateLegacyTaskDeliveryEpoch(team);
      expect(receipt).toMatchObject({ scanned: 4, converted: 3, failed: 0, unresolved: 0 });
    const migratedJournal = fs.readFileSync(teamEventJournalPath(team), "utf8");
    expect(migratedJournal.split("\n")[0]).toBe(originalWorkerLine);
    expect(JSON.parse(migratedJournal.split("\n")[0])).toEqual(worker);
    const events = fs.readFileSync(teamEventJournalPath(team), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events[1]).toMatchObject({
      ref: { taskId: "task-1", version: taskVersionRef("raw-v2"), evidence: "keep-task-ref-evidence" },
      change: "goal",
      taskEvidence: task.taskEvidence,
    });
    expect(events[2]).toMatchObject({
      taskRef: { taskId: "task-1", version: taskVersionRef("raw-v2"), evidence: "keep-alert-ref-evidence" },
      text: alert.text,
    });
    expect(events[1].ref).not.toHaveProperty("authorityId");
    expect(events[1].ref).not.toHaveProperty("nativeId");
    const delivery = JSON.parse(fs.readFileSync(deliveryFile, "utf8"))[0];
    expect(delivery.ref).toMatchObject({ taskId: "task-1", version: taskVersionRef("raw-v2"), evidence: "keep-delivery-ref-evidence" });
    expect(delivery.ref).not.toHaveProperty("authorityId");
    expect(delivery.taskProjection).toMatchObject({ id: "task-1", version: taskVersionRef("raw-v2") });
    expect(listTaskIdsMock).toHaveBeenCalledTimes(1);
    expect(readManyMock).toHaveBeenCalledTimes(1);
  });

  it("migrates event-only history without reading current Task cards", async () => {
    stoppedConfig();
    writeJournal([{
      type: "task",
      cursor: "1",
      ref: { nativeId: "task-1", version: "raw-event-version" },
      change: "goal",
      actor: "lead",
      at: "now",
    }, {
      type: "alert",
      cursor: "2",
      alertId: "alert-2",
      from: "lead",
      to: "worker",
      taskRef: { nativeId: "task-1", version: "raw-event-version" },
      kind: "attention",
      text: "Historic evidence.",
      at: "now",
    }]);

    const receipt = await migrateLegacyTaskDeliveryEpoch(team);
    expect(receipt.converted).toBe(2);
    expect(listTaskIdsMock).toHaveBeenCalledTimes(1);
    expect(readManyMock).not.toHaveBeenCalled();
    const events = fs.readFileSync(teamEventJournalPath(team), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0].ref.version).toBe(taskVersionRef("raw-event-version"));
    expect(events[1].taskRef.version).toBe(taskVersionRef("raw-event-version"));
  });

  it("checks Team scope and refuses active Teams before writing", async () => {
    stoppedConfig();
    const journal = [{ type: "task", cursor: "1", ref: { nativeId: "outside", version: "raw" }, change: "goal", actor: "lead", at: "now" }];
    writeJournal(journal);
    const journalBytes = fs.readFileSync(teamEventJournalPath(team));
    listTaskIdsMock.mockResolvedValue([]);
    await expect(migrateLegacyTaskDeliveryEpoch(team)).rejects.toMatchObject({ name: "upgrade_required" });
    expect(fs.readFileSync(teamEventJournalPath(team))).toEqual(journalBytes);
    expect(readManyMock).not.toHaveBeenCalled();

    fs.writeFileSync(configPath(team), JSON.stringify({ name: team, members: [{ name: "lead", isActive: true }] }));
    await expect(migrateLegacyTaskDeliveryEpoch(team)).rejects.toMatchObject({ name: "upgrade_required" });
    expect(fs.readFileSync(teamEventJournalPath(team))).toEqual(journalBytes);
  });
});
