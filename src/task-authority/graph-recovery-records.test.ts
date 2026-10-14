import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { createTeam, writeConfigAtomic } from "../utils/teams";
import { configPath, taskDeliveryRecoveryPath, teamDir } from "../utils/paths";
import { writeJsonAtomic } from "../utils/atomic-json";
import { readTaskDeliveries, reconcileTaskChanges } from "../utils/task-delivery";
import type { TaskVersionRef } from "./task-version-ref";

const names: string[] = [];
async function fixture() {
  const teamName = `targetless-${process.pid}-${names.length}`; names.push(teamName);
  const config = await createTeam(teamName, "lead-session", "lead");
  config.members.push({ membershipId: "replacement-membership", agentId: "worker", name: "worker", agentType: "teammate", joinedAt: 0, cwd: "/synthetic", sessionFile: "replacement-session", subscriptions: [] });
  writeConfigAtomic(configPath(teamName), config);
  const graph = new DurableGraphTaskAuthority();
  await graph.applyGraph(teamName, { operationId: "apply", tasks: [{ key: "work", title: "Work", goal: "Complete the criterion.", assignee: "worker" }] });
  const task = (await graph.readTasks(teamName))[0];
  const record = { teamName, taskId: task.id, taskVersion: task.version, recipients: ["worker"], changeKind: "assigned", reason: "enqueue-failed", recordedAt: "2026-10-13T00:00:00.000Z", taskProjection: task };
  writeJsonAtomic(taskDeliveryRecoveryPath(teamName), [record]);
  return { teamName, graph, task, record };
}
afterEach(() => { vi.restoreAllMocks(); for (const teamName of names.splice(0)) fs.rmSync(teamDir(teamName), { force: true, recursive: true }); });

it("recovers a pre-0.24 targetless record once to the current replacement Membership", async () => {
  const { teamName, graph } = await fixture();
  expect(await reconcileTaskChanges(teamName, "worker", graph)).toBe(1);
  expect(await reconcileTaskChanges(teamName, "worker", graph)).toBe(0);
  expect(await readTaskDeliveries(teamName, "worker")).toEqual([expect.objectContaining({ recipientMembershipId: "replacement-membership", recipientSessionFile: "replacement-session" })]);
});

it("retires a targetless stale version with one diagnostic and no later replay", async () => {
  const { teamName, graph, task } = await fixture();
  await graph.transition(teamName, { taskId: task.id, operationId: "claim", expectedVersion: task.version as TaskVersionRef, transition: "claim", worker: "worker" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await reconcileTaskChanges(teamName, "worker", graph)).toBe(0);
  expect(await reconcileTaskChanges(teamName, "worker", graph)).toBe(0);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain(`Task ${task.id}, version ${task.version}, recipient worker`);
  expect(await readTaskDeliveries(teamName, "worker")).toEqual([]);
  expect(JSON.parse(fs.readFileSync(taskDeliveryRecoveryPath(teamName), "utf8"))[0]).toHaveProperty("retiredAt");
});

it("retires targetless records when the current assignee differs even at a matching version", async () => {
  const { teamName, task } = await fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await reconcileTaskChanges(teamName, "worker", { readTasks: async () => [{ ...task, assignee: "other" }] })).toBe(0);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(await readTaskDeliveries(teamName, "worker")).toEqual([]);
});

it.each([null, { taskId: "bad", taskVersion: "bad-version", recipients: ["worker"] }])("retires a malformed recovery record without stopping other recovery: %j", async malformed => {
  const { teamName, graph, record } = await fixture();
  writeJsonAtomic(taskDeliveryRecoveryPath(teamName), [malformed, record]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await reconcileTaskChanges(teamName, "worker", graph)).toBe(1);
  expect(await reconcileTaskChanges(teamName, "worker", graph)).toBe(0);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(await readTaskDeliveries(teamName, "worker")).toHaveLength(1);
});

it("retains malformed recovery JSON as retired diagnostic evidence without crashing", async () => {
  const { teamName, graph } = await fixture();
  fs.writeFileSync(taskDeliveryRecoveryPath(teamName), "{malformed");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await reconcileTaskChanges(teamName, "worker", graph)).toBe(0);
  expect(await reconcileTaskChanges(teamName, "worker", graph)).toBe(0);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fs.readFileSync(taskDeliveryRecoveryPath(teamName), "utf8"))[0]).toMatchObject({ malformedSource: "{malformed", retiredAt: expect.any(String) });
});
