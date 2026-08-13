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
import { readBeadsAuthorityFingerprint, resolveBdExecutable } from "./beads";
import * as messaging from "../alert-authority/inbox-delivery";
import * as paths from "./paths";
import * as runtime from "./runtime";
import { DIRECT_MESSAGE_CUSTOM_TYPE, DIRECT_MESSAGE_RESUME_TYPE } from "./message-delivery";
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
  };
}

function extensionHarness() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler[]>();
  const sendMessage = vi.fn();
  piTeams({
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage,
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as never);
  return {
    tools,
    sendMessage,
    async emit(event: string, payload: unknown, context: ReturnType<typeof sessionContext>) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, context);
    },
    async invoke(toolName: string, callId: string, params: Record<string, unknown>, context: ReturnType<typeof sessionContext>) {
      const tool = tools.get(toolName);
      expect(tool, `missing registered public tool ${toolName}`).toBeDefined();
      for (const handler of handlers.get("tool_call") ?? []) await handler({ toolName }, context);
      return tool!.execute(callId, params, new AbortController().signal, undefined, context);
    },
  };
}

function leaderHarness() {
  vi.stubEnv("PI_TEAM_NAME", "");
  vi.stubEnv("PI_AGENT_NAME", "");
  vi.stubEnv("PI_AGENT_LAUNCH_ID", "");
  vi.stubEnv("TMUX", "");
  return extensionHarness();
}

function workerHarness(teamName: string) {
  vi.stubEnv("PI_TEAM_NAME", teamName);
  vi.stubEnv("PI_AGENT_NAME", "worker-a");
  vi.stubEnv("PI_AGENT_LAUNCH_ID", "");
  vi.stubEnv("TMUX", "");
  return extensionHarness();
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
  );
  const membershipIds: Record<string, string> = {};
  for (const worker of ["worker-a", "worker-b"]) {
    await teams.ensureLogicalWorker(teamName, { name: worker, scope: `${worker} alert characterization capability` });
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
    const created = await lead.invoke("task_graph_apply", "create-task", {
      operation_id: "alert-publication-task",
      tasks: [{
        key: "preserve",
        title: "Preserve Task state",
        goal: "Remain unchanged while Alert delivery and Coordination publication disagree.",
        assignee: "worker-a",
      }],
    }, context);
    const task = created.details.tasks_by_key.preserve;
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
      to: "*",
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

    // The registered lifecycle admits only a current Session binding with its
    // matching live process generation. This fixture creates that real startup
    // prerequisite; direct delivery itself remains unmocked.
    await runtime.writeRuntimeStatus(state.teamName, "worker-a", {
      pid: process.pid,
      startedAt: Date.now(),
      runState: "active",
    }, state.membershipIds["worker-a"]);

    // A new process for the exact accepted recipient still presents the retained
    // Alert even though the Alert event was never appended. An error-stopped
    // presentation stays unacknowledged and resumes after the next process start.
    const worker = workerHarness(state.teamName);
    const workerContext = sessionContext(path.join(path.dirname(state.leaderSessionFile), "worker-a.jsonl"));
    await worker.emit("session_start", { reason: "resume" }, workerContext);
    const firstPresentation = worker.sendMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.customType === DIRECT_MESSAGE_CUSTOM_TYPE);
    expect(firstPresentation).toMatchObject({
      display: true,
      details: {
        recipient: "worker-a",
        recipientMembershipId: state.membershipIds["worker-a"],
        messageIds: [firstDelivery.accepted[0].messageId],
      },
    });
    expect(firstPresentation.content).toContain(firstAlertId);
    await worker.emit("context", {
      messages: [{ role: "custom", customType: firstPresentation.customType, details: firstPresentation.details }],
    }, workerContext);
    await worker.emit("turn_end", { message: { role: "assistant", stopReason: "error" } }, workerContext);
    await worker.emit("session_shutdown", { reason: "quit" }, workerContext);

    const restarted = workerHarness(state.teamName);
    const restartedContext = sessionContext(workerContext.sessionManager.getSessionFile(), [{
      type: "custom_message",
      id: "failed-alert-presentation",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: firstPresentation.customType,
      content: firstPresentation.content,
      display: firstPresentation.display,
      details: firstPresentation.details,
    }]);
    await restarted.emit("session_start", { reason: "resume" }, restartedContext);
    expect(restarted.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: DIRECT_MESSAGE_RESUME_TYPE,
      details: expect.objectContaining({ messageIds: [firstDelivery.accepted[0].messageId] }),
    }), { triggerTurn: true, deliverAs: "steer" });
    await restarted.emit("session_shutdown", { reason: "quit" }, restartedContext);

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
    expect(published.events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "alert",
      cursor: afterRetryCursor,
      alertId: retried.details.alert_id,
      to: "*",
      taskRef: { taskId: task.id, version: task.version },
    })]));
    expect(published.events).not.toEqual(expect.arrayContaining([expect.objectContaining({ alertId: firstAlertId })]));

    const afterRetryTask = await lead.invoke("task_read", "read-after-retry", { task_ids: [task.id] }, context);
    expect(afterRetryTask.details.outcomes[0].task).toEqual(beforeCard);
  }, 60_000);
});
