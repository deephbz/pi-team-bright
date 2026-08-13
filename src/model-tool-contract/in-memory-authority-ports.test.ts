import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createInMemoryModelToolJourney } from "./in-memory-model-tool-journey";
import { exactLeaderSessionId } from "./in-memory-team-port";
import type { TaskVersionRef } from "../task-authority/task-version-ref";

const session = exactLeaderSessionId("019fc274-f97e-7910-b6b6-579a20b3b1d0");

describe("isolated in-memory authority fakes", () => {
  it("commits a Task before injected publication failure and does not advance observation", async () => {
    const { ports } = createInMemoryModelToolJourney();
    await ports.team.createTeam(session, { name: "team", purpose: "purpose" });
    await ports.team.ensureWorker(session, { name: "worker", scope: "scope" });
    const created = await ports.task.createTask(session, { operationId: "create", title: "task", goal: "goal", assignee: "worker" });
    if (created.kind !== "created") throw new Error("Task creation must succeed in the fixture.");
    const snapshot = await ports.coordination.readTeamSync(session, "snapshot", new AbortController().signal, "snapshot");
    expect(snapshot.kind).toBe("snapshot");
    ports.coordination.setBranchContext(session, ["entry"]);
    expect(ports.coordination.acknowledgePendingObservation(session, "entry", ["entry"])).toBe(true);
    ports.coordination.failNextPublication("task");
    await expect(ports.task.updateTasks(session, [{ taskId: created.task.id, operationId: "update", expectedVersion: created.task.version as TaskVersionRef, currentContext: "Committed before publication." }])).resolves.toMatchObject({ kind: "batch", outcomes: [{ kind: "updated", task: { current_context: "Committed before publication." } }] });
    const read = await ports.task.readTasks(session, [created.task.id]);
    expect(read).toMatchObject({ kind: "read", tasks: [{ current_context: "Committed before publication." }] });
    const controller = new AbortController();
    const waiting = ports.coordination.readTeamSync(session, "updates", controller.signal, "updates");
    controller.abort();
    await expect(waiting).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("returns replayable durable-style create warnings after Task publication failure", async () => {
    const { ports, debug } = createInMemoryModelToolJourney();
    await ports.team.createTeam(session, { name: "team", purpose: "purpose" });
    await ports.team.ensureWorker(session, { name: "worker", scope: "scope" });
    ports.coordination.failNextPublication("task");
    const created = await ports.task.createTask(session, { operationId: "create", title: "task", goal: "goal", assignee: "worker" });
    expect(created).toMatchObject({ kind: "created", deliveryWarnings: ["Injected task publication failure."] });
    const replay = await ports.task.createTask(session, { operationId: "create", title: "task", goal: "goal", assignee: "worker" });
    expect(replay).toEqual(created);
    expect(debug.readRevision()).toBe(3);
  });

  it("maps Alert publication failure to durable unavailable after retaining delivery without Coordination advance", async () => {
    const { ports, debug } = createInMemoryModelToolJourney();
    await ports.team.createTeam(session, { name: "team", purpose: "purpose" });
    await ports.team.ensureWorker(session, { name: "worker", scope: "scope" });
    await ports.coordination.readTeamSync(session, "snapshot", new AbortController().signal, "snapshot");
    ports.coordination.setBranchContext(session, ["snapshot"]);
    expect(ports.coordination.acknowledgePendingObservation(session, "snapshot", ["snapshot"])).toBe(true);
    const revision = debug.readRevision();
    ports.coordination.failNextPublication("alert");
    await expect(ports.alert.sendAlert(session, { target: { kind: "worker", name: "worker" }, kind: "attention", text: "review" })).resolves.toEqual({ kind: "unavailable", reason: "team_authority_unavailable", message: "Injected alert publication failure." });
    expect(ports.alert.readAcceptedDeliveries()).toMatchObject([{ id: "alert-3", recipients: ["worker"], text: "review" }]);
    expect(debug.readRevision()).toBe(revision + 1);
    expect(ports.coordination.getPendingObservation?.(session)).toBeUndefined();
    const controller = new AbortController();
    const waiting = ports.coordination.readTeamSync(session, "updates", controller.signal, "failure-updates");
    controller.abort();
    await expect(waiting).resolves.toMatchObject({ kind: "cancelled" });
    await expect(ports.alert.sendAlert(session, { target: { kind: "worker", name: "worker" }, kind: "attention", text: "retry" })).resolves.toMatchObject({ kind: "sent", alertId: "alert-5" });
  });

  it("publishes accepted Alert evidence and wakes an updates waiter", async () => {
    const { ports } = createInMemoryModelToolJourney();
    await ports.team.createTeam(session, { name: "team", purpose: "purpose" });
    await ports.team.ensureWorker(session, { name: "worker", scope: "scope" });
    await ports.coordination.readTeamSync(session, "snapshot", new AbortController().signal, "snapshot");
    ports.coordination.setBranchContext(session, ["snapshot"]);
    expect(ports.coordination.acknowledgePendingObservation(session, "snapshot", ["snapshot"])).toBe(true);
    const waiting = ports.coordination.readTeamSync(session, "updates", new AbortController().signal, "updates");
    await ports.alert.sendAlert(session, { target: { kind: "worker", name: "worker" }, kind: "attention", text: "review" });
    await expect(waiting).resolves.toMatchObject({ kind: "updates" });
  });

  it("keeps fake state opaque and composes only narrow lazy ports", () => {
    const source = fs.readFileSync(path.join(__dirname, "in-memory-authority-ports.ts"), "utf8");
    const composition = fs.readFileSync(path.join(__dirname, "in-memory-model-tool-journey.ts"), "utf8");
    expect(source).not.toContain("InMemoryModelToolTestWorld");
    expect(source).not.toMatch(/constructor\([^)]*(world|InMemory(?:Team|Task|Alert|Coordination)ApplicationPort)/);
    expect(composition).toContain("let team:");
    expect(composition).toContain("const teamQuery");
    expect(composition).toContain("const publication");
  });
});
