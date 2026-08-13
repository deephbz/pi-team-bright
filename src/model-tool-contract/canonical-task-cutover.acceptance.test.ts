import fs from "node:fs";
import path from "node:path";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { TaskCardSchema } from "./task-domain";
import { taskVersionRef } from "./task-version-ref";
import { BeadsTaskAdapter } from "./beads-task-adapter";
import { enqueueTaskChange, readTaskDeliveries } from "../utils/task-delivery";
import { withSemanticTrace } from "../utils/trace";
import * as teams from "../utils/teams";
import * as paths from "../utils/paths";
import { TASK_METADATA_SCHEMA, type TaskAuthorityRecordEnvelope } from "../utils/beads";
import type { TaskAuthorityRecord } from "../utils/beads";
import { projectTaskForAgent } from "../utils/task-delivery";
import { migrateLegacyTaskDeliveryEpoch } from "../utils/task-delivery-migration";
import { DurableTaskDeliveryStoppedEpoch } from "../adapters/durable-task-delivery-stopped-epoch";
import { projectToolResult } from "./result-projection";
import { appendTeamEvent } from "../utils/team-events";
import { taskReadAdapterFactory } from "../../test/support/task-authority-read-port";

const createdTeams: string[] = [];
const missingTeamReadFactory = taskReadAdapterFactory({
  readTaskAuthorityRecordEnvelope: async () => { throw new Error("missing Team has no Task authority"); },
  readTaskAuthorityRecordEnvelopes: async () => { throw new Error("missing Team has no Task authority"); },
  listTaskIds: async () => { throw new Error("missing Team has no Task authority"); },
});

function authorityRecord(overrides: Partial<TaskAuthorityRecord> = {}, goal = "Run the focused acceptance check and report its result."): TaskAuthorityRecordEnvelope {
  const task: TaskAuthorityRecord = {
    id: "task-1",
    title: "Verify the cutover",
    description: "Compatibility prose must not become the goal.",
    acceptanceCriteria: "The canonical card is executable.",
    status: "open",
    relations: [],
    version: "beads_authority_version_7",
    provenance: { authority: "beads", teamName: "cutover" },
    ...overrides,
  };
  return {
    task,
    taskMetadata: {
      schema: TASK_METADATA_SCHEMA,
      goal,
      current_context: "Work has not started.",
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const teamName of createdTeams.splice(0)) fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
});

describe("canonical Task cutover acceptance", () => {
  it("projects one neutral card with only an opaque revision", async () => {
    const adapter = new BeadsTaskAdapter("cutover", "team-lead", {
      mode: "read_only",
      readMany: async () => [],
      list: async () => [],
      read: async () => authorityRecord(),
    });
    const result = await adapter.read("task-1");
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(Check(TaskCardSchema, result.task)).toBe(true);
    expect(result.task).toMatchObject({ version: taskVersionRef("beads_authority_version_7"), goal: "Run the focused acceptance check and report its result." });
    expect(result.task).not.toHaveProperty("description");
    expect(result.task).toHaveProperty("relations", []);
    expect(result.task).toHaveProperty("dependency_state", { kind: "ready", active_blocker_ids: [] });
    expect(result.task).not.toHaveProperty("provenance");
    expect(result.task.version).not.toBe("beads_authority_version_7");
  });

  it("does not turn an oversized goal into executable prose", async () => {
    const adapter = new BeadsTaskAdapter("cutover", "team-lead", {
      mode: "read_only",
      readMany: async () => [],
      list: async () => [],
      read: async () => authorityRecord({ title: "A".repeat(100) }, "G".repeat(1_001)),
    });
    const result = await adapter.read("task-1");
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect((result.task as { goal_state?: string }).goal_state).toBe("incomplete");
    expect(result.task.projection_warnings).toEqual(expect.arrayContaining([expect.objectContaining({ incomplete_fields: ["goal"] })]));
    expect(result.task.title).toBe("A".repeat(79) + "…");
  });

  it("rejects raw revisions on every delivery projection path", () => {
    expect(() => projectTaskForAgent({
      id: "task-raw",
      title: "Raw revision",
      status: "open",
      version: "beads_raw_revision",
      goal: "Keep this goal executable.",
      current_context: "Ready.",
    })).toThrowError(expect.objectContaining({ name: "upgrade_required" }));
    expect(() => projectTaskForAgent({
      id: "task-public",
      title: "Raw card revision",
      status: "open",
      version: "beads_raw_card_revision",
      goal: "Keep this goal executable.",
      current_context: "Ready.",
    } as any)).toThrowError(expect.objectContaining({ name: "upgrade_required" }));
    expect(projectTaskForAgent({
      id: "task-public",
      title: "Public revision",
      status: "open",
      version: taskVersionRef("beads_public_revision"),
      goal: "Keep this goal executable.",
      current_context: "Ready.",
    }).version).toBe(taskVersionRef("beads_public_revision"));
  });

  it("refuses raw versions in normal event and result projections", async () => {
    expect(() => projectToolResult("task_link", {
      kind: "task_linked",
      task_id: "task-1",
      target_id: "task-2",
      relation: "related",
      action: "add",
      changed: true,
      version: "beads_raw_revision",
    } as any)).toThrowError(expect.objectContaining({ name: "upgrade_required" }));

    const teamName = `event-version-${process.pid}-${Date.now()}`;
    createdTeams.push(teamName);
    await teams.createTeam(teamName, "lead-session", "lead-agent", "", undefined, undefined, `/tmp/${teamName}-beads`, `authority-${teamName}`, {
      schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: teamName, projectId: teamName,
    });
    await expect(appendTeamEvent(teamName, {
      type: "task",
      ref: { taskId: "task-1", version: "beads_raw_revision" as any },
      change: "goal",
      actor: "worker",
    })).rejects.toThrowError(expect.objectContaining({ name: "upgrade_required" }));
  });

  it("keeps delivery projection equal to the card supplied at publication", async () => {
    const record = authorityRecord();
    const projected = await new BeadsTaskAdapter("cutover", "team-lead", {
      mode: "read_only",
      readMany: async () => [],
      list: async () => [],
      read: async () => record,
    }).read("task-1");
    expect(projected.kind).toBe("found");
    if (projected.kind !== "found") return;
    const card = projectTaskForAgent(projected.task);
    expect(card.version).toBe(taskVersionRef(record.task.version));
    expect(card).not.toHaveProperty("description");
    expect(card).not.toHaveProperty("acceptanceCriteria");
  });

  it("keeps authority records below the adapter and rejects delivery normalization", () => {
    const facade = fs.readFileSync(path.join(process.cwd(), "src/utils/tasks.ts"), "utf8");
    const delivery = fs.readFileSync(path.join(process.cwd(), "src/utils/task-delivery.ts"), "utf8");
    const adapter = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/beads-task-adapter.ts"), "utf8");
    const port = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/durable-model-tool-port.ts"), "utf8");
    const status = fs.readFileSync(path.join(process.cwd(), "src/utils/team-status.ts"), "utf8");
    expect(facade).not.toMatch(/interface\s+TaskAuthorityRecord|interface\s+TaskAuthorityRecordEnvelope|class\s+BeadsTaskStore|new\s+BeadsTaskStore/);
    expect(delivery).not.toMatch(/effectiveVersion|taskPublicationState|BeadsTaskStore|utils\/beads/);
    expect(delivery).not.toMatch(/task:\s*unknown|taskProjection\?:/);
    expect(delivery).not.toContain("boundedDisplay");
    expect(port).not.toMatch(/BeadsError|mutateTaskLink|tasks\.readTask/);
    expect(status).not.toMatch(/BeadsTaskStore|utils\/beads/);
    expect(adapter).toMatch(/TaskAuthorityRecord/);
    expect(adapter).toMatch(/async link\(/);
  });

  it("keeps Task command ownership and reconciliation below the trio-facing port", () => {
    const contracts = fs.readFileSync(path.join(process.cwd(), "src/task-authority/contracts.ts"), "utf8");
    const inMemoryPort = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/in-memory-team-port.ts"), "utf8");
    const modelContracts = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/model-tool-contracts.ts"), "utf8");
    const taskAdapter = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/beads-task-adapter.ts"), "utf8");
    const reconciliationAdapter = fs.readFileSync(path.join(process.cwd(), "src/task-authority/beads-reconciliation-query.ts"), "utf8");
    const delivery = fs.readFileSync(path.join(process.cwd(), "src/utils/task-delivery.ts"), "utf8");

    expect(contracts).not.toContain("in-memory-team-port");
    expect(inMemoryPort).toMatch(/import type \{[\s\S]*ModelToolTaskUpdateInput[\s\S]*\} from "\.\/model-tool-contracts"/);
    expect(inMemoryPort).toMatch(/export type \{[\s\S]*ModelToolTaskUpdateInput[\s\S]*\} from "\.\/model-tool-contracts"/);
    expect(inMemoryPort).not.toContain('from "../task-authority/contracts"');
    expect(modelContracts).toMatch(/export type \{[\s\S]*ModelToolTaskUpdateInput[\s\S]*\} from "\.\.\/task-authority\/contracts"/);
    expect(taskAdapter).not.toMatch(/from "\.\/in-memory-team-port"/);
    expect(reconciliationAdapter).toContain("implements TaskReconciliationQuery");
    expect(delivery).not.toMatch(/import\([^)]*beads-(?:task|authority)-adapter/);
    expect(delivery).not.toMatch(/from "[^"]*beads-(?:task|authority)-adapter"/);
  });

  it("keeps delivery and historic event migration on exact canonical boundaries", () => {
    const delivery = fs.readFileSync(path.join(process.cwd(), "src/utils/task-delivery.ts"), "utf8");
    const migration = fs.readFileSync(path.join(process.cwd(), "src/utils/task-delivery-migration.ts"), "utf8");
    const cardProjection = delivery.slice(delivery.indexOf("export function projectTaskForAgent"), delivery.indexOf("function recipientBinding"));
    const eventMigration = migration.slice(migration.indexOf("function migrateTaskEvent"), migration.indexOf("/**\n * Migrate stopped-epoch"));

    // Delivery must not expose unknown overloads or rebuild partial cards.
    expect(delivery).not.toMatch(/task:\s*unknown|taskProjection\?:\s*unknown/);
    expect(cardProjection).not.toMatch(/current_context|goal_state|boundedDisplay/);
    expect(cardProjection).toContain("Check(TaskCardSchema, task)");

    // Historic refs use their stored revision, not the current TaskCard version.
    expect(eventMigration).not.toMatch(/TaskCard|card\.version|readMany|cards/);
    expect(eventMigration).toContain("canonicalRef(value.ref, taskId)");
  });

  it("keeps the production boundary free of candidate facades and unreachable legacy tools", () => {
    const production = [
      "src/model-tool-contract/catalog.ts",
      "src/model-tool-contract/executors.ts",
      "src/model-tool-contract/runtime.ts",
      "src/model-tool-contract/result-projection.ts",
      "src/model-tool-contract/tui-projection.ts",
      "src/model-tool-contract/durable-model-tool-port.ts",
      "src/model-tool-contract/pi-registration.ts",
      "src/model-tool-contract/beads-task-adapter.ts",
      "src/model-tool-contract/beads-authority-adapter.ts",
    ].map((file) => fs.readFileSync(path.join(process.cwd(), file), "utf8")).join("\\n");
    const facade = fs.readFileSync(path.join(process.cwd(), "src/utils/tasks.ts"), "utf8");
    const delivery = fs.readFileSync(path.join(process.cwd(), "src/utils/task-delivery.ts"), "utf8");
    const extension = fs.readFileSync(path.join(process.cwd(), "extensions/index.ts"), "utf8");
    expect(production).not.toMatch(/Candidate(?:Task|Beads)/);
    expect(facade).not.toMatch(/TaskAuthorityRecord|TaskAuthorityRecordEnvelope|BeadsTaskStore|readTaskAuthority|listTaskIds/);
    for (const rawExport of ["BEADS_WORKSPACE_ENV", "applySemanticTaskUpdate", "createTask", "mutateTaskLink", "resolveTeamTaskAuthority", "TaskCreateReceipt", "TaskMutationReceipt", "InternalTaskPublicationOptions"]) {
      expect(facade).not.toContain(rawExport);
    }
    expect(delivery).not.toContain("TaskPublicationInput");
    expect(delivery).not.toMatch(/task:\s*unknown|taskProjection\?:/);
    for (const legacyTool of ["send_message", "broadcast_message", "read_inbox", "task_list", "check_teammate", "report_stale_agent_sessions", "create_predefined_team", "save_team_as_template"]) {
      expect(extension).not.toContain(`name: "${legacyTool}"`);
    }
  });

  it("keeps registered Worker schemas free of authority and legacy Task vocabulary", () => {
    vi.stubEnv("PI_AGENT_NAME", "worker");
    vi.stubEnv("PI_TEAM_NAME", "cutover");
    const tools: Array<{ name: string; parameters: unknown; description?: string }> = [];
    piTeams({
      registerTool(tool: { name: string; parameters: unknown; description?: string }) { tools.push(tool); },
      on() {},
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    } as never);
    const publicText = JSON.stringify(tools);
    for (const word of ["beads", "bd", "taskfile", "tasksnapshot", "dolt", "acceptance_criteria", "relations", "provenance", "deliveryid", "recipientmembershipid", "recipientsessionfile", "authorityid", "nativeid"]) {
      expect(publicText.toLowerCase()).not.toContain(word);
    }
  });

  it("keeps mutation card and delivery card equal without an added authority call", async () => {
    const teamName = `canonical-delivery-${process.pid}-${Date.now()}`;
    createdTeams.push(teamName);
    const workspace = `/tmp/${teamName}-beads`;
    await teams.createTeam(teamName, "lead-session", "lead-agent", "", undefined, undefined, workspace, `authority-${teamName}`, {
      schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: teamName, projectId: teamName,
    });
    await teams.addMember(teamName, {
      agentId: `worker@${teamName}`, name: "worker", agentType: "teammate", joinedAt: Date.now(),
      tmuxPaneId: "", sessionFile: `/tmp/${teamName}-worker.jsonl`, cwd: process.cwd(), subscriptions: [],
    });
    const record = authorityRecord({ assignee: "worker" });
    const metadata = record.taskMetadata as { goal: string; current_context: string };
    const adapter = new BeadsTaskAdapter(teamName, "team-lead", {
      mode: "publishing",
      readMany: async () => [],
      list: async () => [],
      create: async () => ({ task: record.task, before: record.task, changed: true, appliedOperations: ["create"], deliveryDegraded: false, deliveryWarnings: [], publication: { teamEvent: { appended: false }, delivery: { attemptedRecipients: [], failedRecipients: [], recoveryRecordedFor: [], recoveryRecordFailedFor: [] } } }),
      update: async () => { throw new Error("unused update"); },
      link: async () => { throw new Error("unused link"); },
      read: async () => record,
    });
    const mutation = await adapter.createWithReceipt({ operationId: "create-parity", title: record.task.title, goal: metadata.goal, assignee: "worker" });
    expect(mutation.kind).toBe("created");
    if (mutation.kind !== "created") return;
    const traceFile = path.join("/tmp", `${teamName}.trace.jsonl`);
    vi.stubEnv("PI_TEAMS_TRACE_JSONL", traceFile);
    await withSemanticTrace("task_delivery", { teamName, taskId: mutation.task.id }, () =>
      enqueueTaskChange(teamName, mutation.task, "assigned", "team-lead"));
    const traces = fs.readFileSync(traceFile, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(traces.at(-1)).toMatchObject({ operation: "task_delivery", bdCallCount: 0 });
    const delivery = await readTaskDeliveries(teamName, "worker");
    expect(delivery).toHaveLength(1);
    expect(delivery[0]?.taskProjection).toEqual(mutation.task);
    fs.rmSync(traceFile, { force: true });
  });

  it("does not create stopped-epoch records when none exist", async () => {
    await expect(migrateLegacyTaskDeliveryEpoch(
      `missing-migration-team-${process.pid}`,
      missingTeamReadFactory,
      new DurableTaskDeliveryStoppedEpoch(),
    ))
      .resolves.toMatchObject({ scanned: 0, converted: 0, failed: 0 });
  });
});
