import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { captureTrioProjection, type RegisteredToolLike } from "../../test/support/external-harness";
import { DurableTaskAuthorityRead } from "../adapters/durable-task-authority-read";
import { taskVersionRef } from "../model-tool-contract/task-version-ref";
import { TASK_METADATA_SCHEMA } from "./beads";
import { configPath, taskDir, taskEventFailureHintPath, teamDir } from "./paths";
import { readTaskEventFailureHintRecords } from "./task-event-failure-hints";
import * as teamEvents from "./team-events";
import * as teams from "./teams";

const fixtures: string[] = [];

function fixtureName(): string {
  const name = `coordination-mixed-records-${process.pid}-${Date.now()}-${fixtures.length}`;
  fixtures.push(name);
  return name;
}

function taskEnvelope(teamName: string, version: string) {
  return {
    task: {
      id: "current-task",
      title: "Current Task",
      description: "Compatibility description.",
      acceptanceCriteria: "Compatibility acceptance criteria.",
      status: "open" as const,
      relations: [],
      version,
      provenance: { authority: "beads" as const, teamName },
    },
    taskMetadata: {
      schema: TASK_METADATA_SCHEMA,
      goal: "Keep Coordination observations complete.",
      current_context: "Current Task evidence.",
    },
  };
}

function sessionContext(sessionFile: string) {
  const branch: any[] = [];
  return {
    cwd: process.cwd(),
    mode: "tui",
    isIdle: vi.fn(() => false),
    sessionManager: {
      getSessionId: vi.fn(() => sessionFile),
      getSessionFile: vi.fn(() => sessionFile),
      getBranch: vi.fn(() => branch),
      getEntries: vi.fn(() => branch),
      buildContextEntries: vi.fn(() => branch),
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn(), setTitle: vi.fn() },
    branch,
  };
}

function registeredLeaderHarness() {
  const tools = new Map<string, RegisteredToolLike>();
  const handlers = new Map<string, Array<(event: any, context: any) => unknown>>();
  piTeams({
    registerTool(tool: RegisteredToolLike) { tools.set(tool.name, tool); },
    registerMessageRenderer() {},
    on(event: string, handler: (event: any, context: any) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: vi.fn(), appendEntry: vi.fn(), sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => []), getAllTools: vi.fn(() => []), setActiveTools: vi.fn(),
  } as never);
  return {
    tool(name: string) {
      const tool = tools.get(name);
      expect(tool, `missing registered ${name} tool`).toBeDefined();
      return tool!;
    },
    async emit(event: string, payload: any, context: any) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, context);
    },
  };
}

async function invoke(harness: ReturnType<typeof registeredLeaderHarness>, context: ReturnType<typeof sessionContext>, callId: string, view: "snapshot" | "updates") {
  await harness.emit("tool_call", { toolName: "team_sync" }, context);
  return captureTrioProjection({ tool: harness.tool("team_sync"), args: { view }, context, toolCallId: callId });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of fixtures.splice(0)) {
    fs.rmSync(teamDir(name), { recursive: true, force: true });
    fs.rmSync(taskDir(name), { recursive: true, force: true });
  }
});

describe("native team_sync tool results", () => {
  it("stamps machine details and derives the next page from persisted results without a provider turn", async () => {
    const name = fixtureName(), sessionFile = `/tmp/${name}-lead.jsonl`;
    await teams.createTeam(name, sessionFile, "lead-agent", "Native observation fixture");
    const config = await teams.readConfig(name);
    config.logicalWorkers = [{ name: "worker", scope: "work" }];
    teams.writeConfigAtomic(configPath(name), config);
    vi.stubEnv("PI_TEAM_NAME", ""); vi.stubEnv("PI_AGENT_NAME", "");
    vi.spyOn(DurableTaskAuthorityRead.prototype, "listTaskIds").mockResolvedValue(["current-task"]);
    vi.spyOn(DurableTaskAuthorityRead.prototype, "readTaskAuthorityRecordEnvelopes").mockResolvedValue([taskEnvelope(name, "v1")]);
    const harness = registeredLeaderHarness(), context = sessionContext(sessionFile);
    const snapshot = await invoke(harness, context, "snapshot", "snapshot");
    expect(snapshot.machine?.details).toMatchObject({ kind: "snapshot", observation: { team: name, epoch: config.epochId, binding: config.members[0].membershipId, from: 0, through: 0 } });
    expect(snapshot.model?.text).not.toContain('"observation"');
    context.branch.push({ id: "snapshot", type: "message", message: { role: "toolResult", toolName: "team_sync", toolCallId: "snapshot", content: snapshot.model?.content, details: snapshot.machine?.details } });
    await teamEvents.appendTeamEvent(name, { type: "worker", worker: "worker", membershipId: "worker", phase: "prepared" });
    const updates = await invoke(harness, context, "updates", "updates");
    expect(updates.machine?.details).toMatchObject({ kind: "updates", observation: { from: 0, through: 1 }, worker_changes: [{ worker: "worker" }] });
    expect(fs.existsSync(`${teamDir(name)}/hidden-observations`)).toBe(false);
  });
});
