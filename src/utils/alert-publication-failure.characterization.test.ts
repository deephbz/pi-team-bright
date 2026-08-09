import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import {
  assertCursorAdvanced,
  assertCursorUnchanged,
} from "../../test/support/external-harness";
import { MODEL_TOOL_IMPLEMENTATION_VERSION } from "../model-tool-contract/model-tool-constants";
import { readBeadsAuthorityFingerprint, resolveBdExecutable } from "./beads";
import * as messaging from "./messaging";
import * as paths from "./paths";
import { readTeamEventCursor, readTeamEvents } from "./team-events";
import * as teams from "./teams";

type RegisteredTool = {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    context: ReturnType<typeof sessionContext>,
  ): Promise<any>;
};

type Handler = (event: unknown, context: ReturnType<typeof sessionContext>) => Promise<unknown> | unknown;

const createdTeams: string[] = [];
const createdRoots: string[] = [];
let sequence = 0;

function tempRoot(suffix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `alert-publication-${suffix}-`));
  createdRoots.push(root);
  return root;
}

function initBeadsWorkspace(): string {
  const workspace = path.join(tempRoot("beads"), "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync(resolveBdExecutable(), ["init", "--quiet", "--skip-agents", "--skip-hooks"], {
    cwd: workspace,
    stdio: "ignore",
  });
  return workspace;
}

function sessionContext(sessionFile: string) {
  return {
    cwd: process.cwd(),
    mode: "tui",
    model: undefined,
    isIdle: vi.fn(() => false),
    shutdown: vi.fn(),
    sessionManager: {
      getSessionId: vi.fn(() => sessionFile),
      getSessionFile: vi.fn(() => sessionFile),
      getBranch: vi.fn(() => []),
      buildContextEntries: vi.fn(() => []),
      getEntries: vi.fn(() => []),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setFooter: vi.fn(),
      setTitle: vi.fn(),
    },
  };
}

function leaderHarness() {
  vi.stubEnv("PI_TEAM_NAME", "");
  vi.stubEnv("PI_AGENT_NAME", "");
  vi.stubEnv("PI_AGENT_LAUNCH_ID", "");
  vi.stubEnv("TMUX", "");
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler[]>();
  piTeams({
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as never);
  return {
    tools,
    async invoke(toolName: string, callId: string, params: Record<string, unknown>, context: ReturnType<typeof sessionContext>) {
      const tool = tools.get(toolName);
      expect(tool, `missing registered public tool ${toolName}`).toBeDefined();
      for (const handler of handlers.get("tool_call") ?? []) await handler({ toolName }, context);
      return tool!.execute(callId, params, new AbortController().signal, undefined, context);
    },
  };
}

async function fixture() {
  const teamName = `alert-publication-${process.pid}-${Date.now()}-${sequence++}`;
  createdTeams.push(teamName);
  const workspace = initBeadsWorkspace();
  const sessionRoot = tempRoot("sessions");
  const leaderSessionFile = path.join(sessionRoot, "leader.jsonl");
  await teams.createTeam(
    teamName,
    leaderSessionFile,
    `leader@${teamName}`,
    "Alert publication failure characterization",
    undefined,
    undefined,
    workspace,
    `task_authority_${crypto.randomUUID()}`,
    readBeadsAuthorityFingerprint(workspace),
    undefined,
    undefined,
    MODEL_TOOL_IMPLEMENTATION_VERSION,
  );
  const membershipIds: Record<string, string> = {};
  for (const worker of ["worker-a", "worker-b"]) {
    const membershipId = teams.newMembershipId();
    membershipIds[worker] = membershipId;
    await teams.addMember(teamName, {
      membershipId,
      agentId: `${worker}@${teamName}`,
      name: worker,
      agentType: "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      sessionFile: path.join(sessionRoot, `${worker}.jsonl`),
      cwd: process.cwd(),
      subscriptions: [],
    });
  }
  return { teamName, leaderSessionFile, membershipIds };
}

function alertIdFromDelivery(text: string): string {
  const match = text.match(/Alert (alert_[^\]]+)\]/);
  if (!match) throw new Error(`Accepted Message has no Alert identity: ${text}`);
  return match[1];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
  for (const root of createdRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Alert acceptance followed by Coordination publication failure", () => {
  it("keeps exact native receipts but returns an ambiguous unavailable result whose retry duplicates accepted delivery", async () => {
    const state = await fixture();
    const lead = leaderHarness();
    const context = sessionContext(state.leaderSessionFile);
    const created = await lead.invoke("task_create", "create-task", {
      tasks: [{
        operation_id: "alert-publication-task",
        title: "Preserve Task state",
        goal: "Remain unchanged while Alert delivery and Coordination publication disagree.",
      }],
    }, context);
    const task = created.details.outcomes[0].task;
    const beforeTask = await lead.invoke("task_read", "read-before-alert", { task_ids: [task.id] }, context);
    const beforeCard = beforeTask.details.outcomes[0].task;
    const beforeCursor = readTeamEventCursor(state.teamName);

    // Keep one current recipient writable and make the second current recipient
    // refuse at its real durable inbox boundary. No delivery implementation is mocked.
    fs.mkdirSync(paths.inboxPath(state.teamName, "worker-b"), { recursive: true });
    const broadcast = vi.spyOn(messaging, "broadcastMessage");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Fail only the Alert event journal open. Native Message acceptance has
    // already committed when sendAlert reaches this Coordination boundary.
    const originalOpen = fs.openSync;
    const eventJournal = paths.teamEventJournalPath(state.teamName);
    const publicationFailure = vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(target) === eventJournal) throw new Error("injected Alert event publication failure");
      return originalOpen(target, flags, mode);
    }) as typeof fs.openSync);

    const alertCall = {
      target: { kind: "team" },
      kind: "announcement",
      text: "Review the Task without changing it.",
      task_id: task.id,
      task_version: task.version,
    };
    const failed = await lead.invoke("alert_send", "alert-publication-fails", alertCall, context);
    expect(failed.details).toEqual({
      kind: "unavailable",
      reason: "team_authority_unavailable",
      message: "injected Alert event publication failure",
      state_changed: false,
    });

    const firstDelivery = await broadcast.mock.results[0].value;
    expect(firstDelivery).toEqual({
      accepted: [{ recipient: "worker-a", messageId: expect.stringMatching(/^message_/) }],
      failures: [{ recipient: "worker-b", error: expect.stringMatching(/EISDIR|directory/i) }],
    });
    const acceptedAfterFailure = await messaging.readInbox(state.teamName, "worker-a", false, false);
    expect(acceptedAfterFailure).toEqual([expect.objectContaining({
      id: firstDelivery.accepted[0].messageId,
      recipientMembershipId: state.membershipIds["worker-a"],
      from: "team-lead",
      read: false,
      text: expect.stringContaining(`Task: ${task.id} @ ${task.version}`),
    })]);
    const firstAlertId = alertIdFromDelivery(acceptedAfterFailure[0].text);

    assertCursorUnchanged(beforeCursor, readTeamEventCursor(state.teamName));
    expect(readTeamEvents(state.teamName, { afterCursor: beforeCursor })).toMatchObject({
      cursor: beforeCursor,
      headCursor: beforeCursor,
      events: [],
    });
    expect(JSON.parse(fs.readFileSync(paths.teamEventCursorStatePath(state.teamName), "utf8"))).toMatchObject({ cursor: beforeCursor });
    const afterFailureTask = await lead.invoke("task_read", "read-after-failure", { task_ids: [task.id] }, context);
    expect(afterFailureTask.details.outcomes[0].task).toEqual(beforeCard);

    // The public call has no operation coordinate and the unavailable result
    // omits the accepted and refused recipients. An exact retry therefore
    // cannot reconcile the first Message; it creates a second Alert identity.
    expect(JSON.stringify(lead.tools.get("alert_send")!.parameters)).not.toContain("operation_id");
    expect(failed.details).not.toHaveProperty("accepted_recipients");
    expect(failed.details).not.toHaveProperty("failed_recipients");
    publicationFailure.mockRestore();

    const retried = await lead.invoke("alert_send", "alert-publication-retry", alertCall, context);
    expect(retried.details).toMatchObject({
      kind: "alert_sent",
      alert_id: expect.stringMatching(/^alert_/),
      accepted_recipients: ["worker-a"],
      failed_recipients: ["worker-b"],
      task_state_changed: false,
    });
    const messagesAfterRetry = await messaging.readInbox(state.teamName, "worker-a", false, false);
    expect(messagesAfterRetry).toHaveLength(2);
    expect(messagesAfterRetry.map((message) => message.id)).toEqual([
      firstDelivery.accepted[0].messageId,
      (await broadcast.mock.results[1].value).accepted[0].messageId,
    ]);
    expect(new Set(messagesAfterRetry.map((message) => alertIdFromDelivery(message.text))).size).toBe(2);
    expect(alertIdFromDelivery(messagesAfterRetry[1].text)).toBe(retried.details.alert_id);
    expect(retried.details.alert_id).not.toBe(firstAlertId);

    const afterRetryCursor = readTeamEventCursor(state.teamName);
    assertCursorAdvanced(beforeCursor, afterRetryCursor);
    const published = readTeamEvents(state.teamName, { afterCursor: beforeCursor });
    expect(published.events).toEqual([expect.objectContaining({
      type: "alert",
      cursor: afterRetryCursor,
      alertId: retried.details.alert_id,
      to: "*",
      taskRef: { taskId: task.id, version: task.version },
    })]);
    expect(published.events).not.toEqual(expect.arrayContaining([expect.objectContaining({ alertId: firstAlertId })]));

    const afterRetryTask = await lead.invoke("task_read", "read-after-retry", { task_ids: [task.id] }, context);
    expect(afterRetryTask.details.outcomes[0].task).toEqual(beforeCard);
  }, 60_000);
});
