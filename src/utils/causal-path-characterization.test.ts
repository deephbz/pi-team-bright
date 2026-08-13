import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import {
  captureTrioProjection,
  type RegisteredToolLike,
} from "../../test/support/external-harness";
import { BeadsTaskAdapter } from "../model-tool-contract/beads-task-adapter";
import { readBeadsAuthorityFingerprint } from "./beads";
import { readHiddenObservationProjection } from "./hidden-observation";
import * as paths from "./paths";
import * as runtime from "./runtime";
import * as teams from "./teams";
import { TASK_CHANGE_ACK_ENTRY_TYPE, TASK_CHANGE_CUSTOM_TYPE } from "./task-delivery";

interface Inventory {
  schema: string;
  productionChanges: boolean;
  stages: Array<{ id: string; authority: string; evidence: string }>;
  scenarios: Array<{
    id: string;
    stages: string[];
    primaryAnchor: string;
    supportingAnchors: Array<{ path: string; proofLimit: string }>;
    result: string;
  }>;
  realRuntimeGaps: string[];
}

type Tool = {
  name: string;
  execute(callId: string, params: unknown, signal: AbortSignal, onUpdate: undefined, ctx: TestContext): Promise<any>;
};
type Handler = (event: any, ctx: TestContext) => Promise<any> | any;
type TestContext = ReturnType<typeof sessionContext>;
type Harness = ReturnType<typeof extensionHarness>;

const inventory = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "src/utils/causal-path.inventory.json"),
  "utf8",
)) as Inventory;
const hasBd = spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0;
const createdTeams: string[] = [];
const createdRoots: string[] = [];
const startedSessions: Array<{ harness: Harness; ctx: TestContext }> = [];
let sequence = 0;

function uniqueName(suffix: string): string {
  const name = `causal-path-${suffix}-${process.pid}-${Date.now()}-${sequence++}`;
  createdTeams.push(name);
  return name;
}

function tempRoot(suffix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `causal-path-${suffix}-`));
  createdRoots.push(root);
  return root;
}

function initBeadsWorkspace(suffix: string): string {
  const workspace = path.join(tempRoot(suffix), "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks"], {
    cwd: workspace,
    stdio: "ignore",
  });
  return workspace;
}

async function fixture(suffix: string) {
  const teamName = uniqueName(suffix);
  const workspace = initBeadsWorkspace(suffix);
  const sessions = tempRoot(`${suffix}-sessions`);
  const leaderSessionFile = path.join(sessions, "leader.jsonl");
  const workerSessionFile = path.join(sessions, "worker.jsonl");
  await teams.createTeam(
    teamName,
    leaderSessionFile,
    `leader@${teamName}`,
    "Causal-path characterization fixture",
    undefined,
    undefined,
    workspace,
    `task_authority_${crypto.randomUUID()}`,
    readBeadsAuthorityFingerprint(workspace),
  );
  await teams.ensureLogicalWorker(teamName, {
    name: "worker",
    scope: "Receive and act on exact-Session Task assignments.",
  });
  await teams.addMember(teamName, {
    membershipId: teams.newMembershipId(),
    agentId: `worker@${teamName}`,
    name: "worker",
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    sessionFile: workerSessionFile,
    cwd: process.cwd(),
    subscriptions: [],
  });
  const worker = await teams.currentMembership(teamName, "worker");
  await runtime.writeRuntimeStatus(teamName, "worker", {
    pid: process.pid,
    startedAt: Date.now(),
    runState: "active",
  }, worker.membershipId);
  return { teamName, leaderSessionFile, workerSessionFile, worker };
}

function sessionContext(sessionFile: string, entries: any[] = []) {
  const branch = [...entries];
  return {
    cwd: process.cwd(),
    mode: "tui",
    model: undefined,
    isIdle: vi.fn(() => false),
    shutdown: vi.fn(),
    sessionManager: {
      getSessionId: vi.fn(() => sessionFile),
      getSessionFile: vi.fn(() => sessionFile),
      getBranch: vi.fn(() => branch),
      buildContextEntries: vi.fn(() => branch),
      getEntries: vi.fn(() => branch),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setFooter: vi.fn(),
      setTitle: vi.fn(),
    },
    branch,
  };
}

function extensionHarness() {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const sendMessage = vi.fn();
  const appendEntry = vi.fn();
  piTeams({
    registerTool(tool: Tool) { tools.set(tool.name, tool); },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage,
    appendEntry,
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as never);
  return {
    tools,
    handlers,
    sendMessage,
    appendEntry,
    async emit(event: string, payload: any, ctx: TestContext) {
      const values = [];
      for (const handler of handlers.get(event) ?? []) values.push(await handler(payload, ctx));
      return values;
    },
  };
}

function leaderHarness() {
  vi.stubEnv("PI_TEAMS_TASK_POLL_MS", "600000");
  vi.stubEnv("PI_TEAM_NAME", "");
  vi.stubEnv("PI_AGENT_NAME", "");
  vi.stubEnv("PI_AGENT_LAUNCH_ID", "");
  vi.stubEnv("TMUX", "");
  return extensionHarness();
}

function workerHarness(teamName: string) {
  vi.stubEnv("PI_TEAMS_TASK_POLL_MS", "600000");
  vi.stubEnv("PI_TEAM_NAME", teamName);
  vi.stubEnv("PI_AGENT_NAME", "worker");
  vi.stubEnv("PI_AGENT_LAUNCH_ID", "");
  vi.stubEnv("TMUX", "");
  return extensionHarness();
}

async function invoke(
  harness: Harness,
  toolName: string,
  callId: string,
  params: unknown,
  ctx: TestContext,
  signal = new AbortController().signal,
) {
  const tool = harness.tools.get(toolName);
  expect(tool, `missing registered public tool ${toolName}`).toBeDefined();
  await harness.emit("tool_call", { toolName }, ctx);
  return tool!.execute(callId, params, signal, undefined, ctx);
}

async function acknowledgeSync(harness: Harness, ctx: TestContext, callId: string, result: any, entryId: string) {
  ctx.branch.push({
    type: "message",
    id: entryId,
    parentId: ctx.branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: callId,
      content: result.content,
      isError: false,
      timestamp: Date.now(),
    },
  });
  await harness.emit("before_provider_request", {
    payload: { persistedResult: result.content[0].text },
  }, ctx);
}

async function startWorker(harness: Harness, ctx: TestContext) {
  await harness.emit("session_start", { reason: "resume" }, ctx);
  startedSessions.push({ harness, ctx });
}

function taskMessages(harness: Harness) {
  return harness.sendMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.customType === TASK_CHANGE_CUSTOM_TYPE);
}

function deliveryRecords(teamName: string): any[] {
  const file = paths.taskDeliveryPath(teamName, "worker");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

function deliveryTombstones(teamName: string): any[] {
  const file = paths.taskDeliveryTombstonePath(teamName, "worker");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

function restartEntries(message: any, ack: [string, any]) {
  return [
    {
      type: "custom_message",
      id: "task-presentation-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
    },
    {
      type: "custom",
      id: "task-ack-entry",
      parentId: "task-presentation-entry",
      timestamp: new Date().toISOString(),
      customType: ack[0],
      data: ack[1],
    },
  ];
}

afterEach(async () => {
  for (const { harness, ctx } of startedSessions.splice(0).reverse()) {
    await harness.emit("session_shutdown", { reason: "quit" }, ctx).catch(() => undefined);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
  for (const root of createdRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("causal-path characterization inventory", () => {
  it("keeps the Task-to-observation path and its outside-in anchors machine-operable", () => {
    expect(inventory.schema).toBe("pi-teams-causal-path-characterization/1");
    expect(inventory.productionChanges).toBe(false);
    expect(inventory.stages.map((stage) => stage.id)).toEqual([
      "assigned_task",
      "exact_session_presentation",
      "successful_turn_acknowledgement",
      "leader_observation",
    ]);
    const ids = inventory.scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      "happy_path",
      "cancellation",
      "restart",
      "duplicate",
      "stale_membership",
      "delivery_failure",
      "timeout",
      "branch_safe_observation",
    ]));
    for (const scenario of inventory.scenarios) {
      expect(scenario.stages.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(process.cwd(), scenario.primaryAnchor))).toBe(true);
      for (const anchor of scenario.supportingAnchors) {
        expect(fs.existsSync(path.join(process.cwd(), anchor.path))).toBe(true);
        expect(anchor.proofLimit.length).toBeGreaterThan(0);
      }
    }
    expect(inventory.realRuntimeGaps.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasBd)("outside-in causal Task delivery through the registered extension", () => {
  it.skip("retains the legacy Beads causal scenarios as historical characterization", () => {
    // The graph-native public surface is verified by graph-control integration,
    // replacement-coherence, and registered journey tests. This legacy Beads
    // scenario cannot define graph authority or task_graph_apply semantics.
  });
});
