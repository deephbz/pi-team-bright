import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BeadsTaskStoreOptions } from "../utils/beads";

const calls: string[] = [];
const storeOptions: BeadsTaskStoreOptions[] = [];
const store = {
  readTaskAuthorityRecordEnvelope: vi.fn(async (id: string) => ({ task: { id } })),
  readTaskAuthorityRecordEnvelopes: vi.fn(async (ids: readonly string[]) => ids.map((id) => ({ task: { id } }))),
  list: vi.fn(async () => [{ id: "first" }, { id: "second" }]),
  listNonterminalTaskIdsAssignedTo: vi.fn(async (worker: string) => worker === "worker" ? ["assigned-task"] : []),
};

vi.mock("../utils/beads", () => ({
  BeadsTaskStore: class { constructor(options: BeadsTaskStoreOptions) { storeOptions.push(options); return store; } },
}));

import { DurableTaskAuthorityRead } from "./durable-task-authority-read";

afterEach(() => {
  calls.length = 0;
  storeOptions.length = 0;
  vi.clearAllMocks();
  delete process.env.PI_TEAMS_TRACE_JSONL;
});

describe("DurableTaskAuthorityRead", () => {
  it("binds the read Team boundary separately for each read operation", async () => {
    const fingerprint = { schema: "test" };
    const team = {
      readBinding: vi.fn(async (teamName: string) => {
        calls.push(`binding:${teamName}`);
        return { teamName, workspace: "/tmp/tasks", authorityFingerprint: fingerprint };
      }),
    };
    const read = new DurableTaskAuthorityRead(team);

    await expect(read.readTaskAuthorityRecordEnvelope("team", "one")).resolves.toEqual({ task: { id: "one" } });
    await expect(read.readTaskAuthorityRecordEnvelopes("team", ["two", "three"])).resolves.toEqual([{ task: { id: "two" } }, { task: { id: "three" } }]);
    await expect(read.listTaskIds("team")).resolves.toEqual(["first", "second"]);
    await expect(read.listNonterminalTaskIdsAssignedToWorker("team", "worker")).resolves.toEqual(["assigned-task"]);

    expect(calls).toEqual(["binding:team", "binding:team", "binding:team", "binding:team"]);
    expect(storeOptions).toEqual([
      { teamName: "team", workspace: "/tmp/tasks", authorityFingerprint: fingerprint, requireExpectedVersion: false },
      { teamName: "team", workspace: "/tmp/tasks", authorityFingerprint: fingerprint, requireExpectedVersion: false },
      { teamName: "team", workspace: "/tmp/tasks", authorityFingerprint: fingerprint, requireExpectedVersion: false },
      { teamName: "team", workspace: "/tmp/tasks", authorityFingerprint: fingerprint, requireExpectedVersion: false },
    ]);
    expect(store.listNonterminalTaskIdsAssignedTo).toHaveBeenCalledWith("worker");
    expect(storeOptions[0]!.authorityFingerprint).toBe(fingerprint);
  });

  it("preserves exact read-binding rejection identity without creating a store", async () => {
    const failure = new Error("read binding unavailable");
    const read = new DurableTaskAuthorityRead({
      readBinding: async () => { throw failure; },
    });

    await expect(read.readTaskAuthorityRecordEnvelope("team", "one")).rejects.toBe(failure);

    expect(storeOptions).toEqual([]);
    expect(store.readTaskAuthorityRecordEnvelope).not.toHaveBeenCalled();
  });

  it("preserves exact Beads store fingerprint/read rejection identity", async () => {
    const failure = Object.assign(new Error("authority fingerprint mismatch"), { kind: "task_authority_unavailable" });
    store.readTaskAuthorityRecordEnvelope.mockRejectedValueOnce(failure);
    const read = new DurableTaskAuthorityRead({
      readBinding: async (teamName) => ({ teamName, workspace: "/tmp/tasks", authorityFingerprint: { schema: "wrong" } }),
    });

    await expect(read.readTaskAuthorityRecordEnvelope("team", "one")).rejects.toBe(failure);
    expect(store.readTaskAuthorityRecordEnvelope).toHaveBeenCalledWith("one");
  });

  it("keeps the read adapter fenced from mutation Team authority", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/adapters/durable-task-authority-read.ts"), "utf8");
    expect(source).toContain("TaskAuthorityReadTeamPort");
    expect(source).not.toContain("TaskAuthorityTeamPort");
    expect(source).not.toContain("withCurrentActor");
  });

  it("preserves the task read semantic trace identities", async () => {
    const trace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-read-trace-")), "trace.jsonl");
    process.env.PI_TEAMS_TRACE_JSONL = trace;
    const read = new DurableTaskAuthorityRead({
      readBinding: async (teamName) => ({ teamName, workspace: "/tmp/tasks", authorityFingerprint: { schema: "test" } }),
    });

    await read.readTaskAuthorityRecordEnvelope("team", "one");
    await read.readTaskAuthorityRecordEnvelopes("team", ["two"]);
    await read.listTaskIds("team");
    await read.listNonterminalTaskIdsAssignedToWorker("team", "worker");

    expect(fs.readFileSync(trace, "utf8").trim().split("\n").map((line) => {
      const record = JSON.parse(line);
      return { operation: record.operation, teamName: record.teamName, taskId: record.taskId, outcome: record.outcome };
    })).toEqual([
      { operation: "task_read", teamName: "team", taskId: "one", outcome: "ok" },
      { operation: "task_read_many", teamName: "team", taskId: undefined, outcome: "ok" },
      { operation: "task_list", teamName: "team", taskId: undefined, outcome: "ok" },
      { operation: "task_list_assigned_nonterminal", teamName: "team", taskId: undefined, outcome: "ok" },
    ]);
  });
});
