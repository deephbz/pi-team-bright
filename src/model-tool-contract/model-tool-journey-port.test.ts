import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ModelToolJourneyFacade } from "./model-tool-journey-facade";
import { createInMemoryModelToolJourney } from "./in-memory-model-tool-journey";
import { InMemoryModelToolTeamPort, exactLeaderSessionId } from "./in-memory-team-port";

const session = "019fc274-f97e-7910-b6b6-579a20b3b1d0" as any;

describe("ModelToolJourneyPort", () => {
  it("routes each authority call through its named port without a transaction", async () => {
    const ports: any = {
      team: { createTeam: vi.fn().mockResolvedValue("team"), ensureWorker: vi.fn(), stopWorker: vi.fn(), shutdownTeam: vi.fn() },
      task: { createTask: vi.fn().mockResolvedValue("task"), readTasks: vi.fn(), updateTasks: vi.fn(), linkTask: vi.fn() },
      alert: { sendAlert: vi.fn().mockResolvedValue("alert") },
      coordination: {
        readSnapshot: vi.fn(), readTeamSync: vi.fn().mockResolvedValue("coordination"),
        setPendingObservationResult: vi.fn(), acknowledgePendingObservation: vi.fn(), setBranchContext: vi.fn(),
      },
    };
    const journey = new ModelToolJourneyFacade(ports.team, ports.task, ports.alert, ports.coordination);

    await expect(journey.team.createTeam(session, { name: "team", purpose: "purpose" })).resolves.toBe("team");
    await expect(journey.task.createTask(session, { operationId: "op", title: "task", goal: "goal" })).resolves.toBe("task");
    await expect(journey.alert.sendAlert(session, { target: { kind: "worker", name: "worker" }, kind: "attention", text: "review" })).resolves.toBe("alert");
    await expect(journey.coordination.readTeamSync(session, "snapshot", new AbortController().signal, "call")).resolves.toBe("coordination");
    expect(ports.team.createTeam).toHaveBeenCalledOnce();
    expect(ports.task.createTask).toHaveBeenCalledOnce();
    expect(ports.alert.sendAlert).toHaveBeenCalledOnce();
    expect(ports.coordination.readTeamSync).toHaveBeenCalledOnce();
  });

  it("keeps the legacy in-memory wrapper and an explicit fake-world journey equivalent", async () => {
    const { world, ports, journey } = createInMemoryModelToolJourney();
    await journey.team.createTeam(session, { name: "team", purpose: "purpose" });
    await journey.team.ensureWorker(session, { name: "worker", scope: "scope" });
    const task = await journey.task.createTask(session, { operationId: "create", title: "task", goal: "goal", assignee: "worker" });

    expect(task.kind).toBe("created");
    expect(world.readDebugRevision()).toBe(3);
    expect(ports.team).not.toBe(ports.task);
    expect(ports.task).not.toBe(ports.alert);
    expect(ports.alert).not.toBe(ports.coordination);
  });

  it("keeps the flat wrapper equal to named ports across pending acknowledgement and updates", async () => {
    const legacy = new InMemoryModelToolTeamPort();
    const named = createInMemoryModelToolJourney();
    const leader = exactLeaderSessionId("019fc274-f97e-7910-b6b6-579a20b3b1d0");
    const create = { name: "team", purpose: "purpose" };
    const worker = { name: "worker", scope: "scope" };
    await legacy.createTeam(leader, create);
    await named.ports.team.createTeam(leader, create);
    await legacy.ensureWorker(leader, worker);
    await named.ports.team.ensureWorker(leader, worker);
    const legacyTask = await legacy.createTask(leader, { operationId: "create", title: "task", goal: "goal", assignee: "worker" });
    const namedTask = await named.ports.task.createTask(leader, { operationId: "create", title: "task", goal: "goal", assignee: "worker" });
    if (legacyTask.kind !== "created" || namedTask.kind !== "created") throw new Error("Task fixtures must create.");

    const legacySnapshot = await legacy.readTeamSync(leader, "snapshot", new AbortController().signal, "snapshot");
    const namedSnapshot = await named.ports.coordination.readTeamSync(leader, "snapshot", new AbortController().signal, "snapshot");
    expect(namedSnapshot).toEqual(legacySnapshot);
    legacy.setBranchContext(leader, ["snapshot"]);
    named.ports.coordination.setBranchContext(leader, ["snapshot"]);
    expect(named.ports.coordination.acknowledgePendingObservation(leader, "snapshot", ["snapshot"])).toBe(
      legacy.acknowledgePendingObservation(leader, "snapshot", ["snapshot"]),
    );

    const update = { taskId: legacyTask.task.id, operationId: "update", expectedVersion: legacyTask.task.version as `v_${string}`, currentContext: "Updated." };
    await legacy.updateTasks(leader, [update]);
    await named.ports.task.updateTasks(leader, [{ ...update, taskId: namedTask.task.id, expectedVersion: namedTask.task.version as `v_${string}` }]);
    const legacyUpdates = await legacy.readTeamSync(leader, "updates", new AbortController().signal, "updates");
    const namedUpdates = await named.ports.coordination.readTeamSync(leader, "updates", new AbortController().signal, "updates");
    expect(namedUpdates).toEqual(legacyUpdates);
    expect(named.ports.coordination.getPendingObservation?.(leader)).toEqual(legacy.getPendingObservation?.(leader));
  });

  it("restores every optional legacy member through the thin compatibility adapter", async () => {
    const legacy = new InMemoryModelToolTeamPort();
    const leader = exactLeaderSessionId("019fc274-f97e-7910-b6b6-579a20b3b1d0");
    legacy.setLeaderSessionFile?.(leader, "/tmp/leader.jsonl");
    legacy.setLeaderLaunchContext?.(leader, { cwd: "/tmp", projectTrusted: true });
    await expect(legacy.acknowledgePendingObservationAsync?.(leader, "entry", ["entry"])).resolves.toBe(false);
    await expect(legacy.readSyncNudgeDebt?.(leader, ["entry"])).resolves.toEqual({ kind: "none" });
    expect(legacy.getPendingObservation?.(leader)).toBeUndefined();
  });

  it("keeps durable authority composition and Coordination hooks at named boundaries", () => {
    const root = path.join(__dirname, "../..");
    const production = [
      "src/model-tool-contract/durable-model-tool-team-application.ts",
      "src/model-tool-contract/durable-model-tool-task-application.ts",
      "src/model-tool-contract/durable-model-tool-alert-application.ts",
      "src/model-tool-contract/durable-model-tool-coordination-application.ts",
      "src/model-tool-contract/durable-model-tool-bindings.ts",
    ].map(file => fs.readFileSync(path.join(root, file), "utf8"));
    expect(production.join("\n")).not.toContain('from "./durable-model-tool-port"');
    const extension = fs.readFileSync(path.join(root, "extensions/index.ts"), "utf8");
    expect(extension).toContain("new DurableModelToolBindings()");
    expect(extension).toContain("new ModelToolJourneyFacade(");
    expect(extension).toContain("modelToolJourney.port.coordination.setBranchContext");
    expect(extension).toContain("modelToolJourney.port.coordination.acknowledgePendingObservation");
  });

  it("keeps shared contracts neutral and wrapper dependencies inward", () => {
    const root = path.join(__dirname, "../..");
    const neutral = fs.readFileSync(path.join(root, "src/model-tool-contract/model-tool-contracts.ts"), "utf8");
    expect(neutral).not.toContain("in-memory-team-port");
    const inward = [
      "src/model-tool-contract/model-tool-journey-port.ts",
      "src/model-tool-contract/in-memory-state.ts",
      "src/model-tool-contract/in-memory-authority-ports.ts",
      "src/model-tool-contract/durable-model-tool-team-application.ts",
      "src/model-tool-contract/durable-model-tool-task-application.ts",
      "src/model-tool-contract/durable-model-tool-alert-application.ts",
      "src/model-tool-contract/durable-model-tool-coordination-application.ts",
      "src/model-tool-contract/durable-model-tool-bindings.ts",
    ].map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
    expect(inward).not.toContain('from "./in-memory-team-port"');
    const wrapper = fs.readFileSync(path.join(root, "src/model-tool-contract/in-memory-team-port.ts"), "utf8");
    expect(wrapper).toContain('from "./model-tool-contracts"');
    expect(wrapper).toContain('from "./in-memory-model-tool-journey"');
  });

  it("keeps Trio execution above named application ports", () => {
    const executors = fs.readFileSync(path.join(__dirname, "executors.ts"), "utf8");
    const registration = fs.readFileSync(path.join(__dirname, "pi-registration.ts"), "utf8");
    expect(executors).toContain('import type { ModelToolJourneyPort } from "./model-tool-journey-port";');
    expect(executors).not.toContain("type ModelToolTeamPort");
    expect(registration).toContain('import type { ModelToolJourneyPort } from "./model-tool-journey-port";');
    expect(registration).not.toContain('type ModelToolTeamPort } from "./in-memory-team-port"');
    expect(registration).toContain('type ModelToolTeamPort } from "./model-tool-contracts"');
  });
});
