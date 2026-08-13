import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { taskVersionRef } from "../../src/model-tool-contract/task-version-ref";
import { projectToolResult } from "../../src/model-tool-contract/result-projection";
import {
  captureToolCase,
  writeQaBundle,
  type QaBrief,
  type QaBundle,
  type QaCase,
  type RegisteredTool,
} from "./harness";

const outputPath = path.resolve(
  process.env.PI_TEAMS_QA_OUTPUT || path.join(process.cwd(), "artifacts", "tool-result-qa", "latest.json"),
);

type QaToolResultEntry = {
  id: string;
  type: "message";
  message: { role: "toolResult"; toolCallId: string; content: any[] };
};

function brief(
  situation: string,
  agentNextDecision: string,
  humanQuestion: string,
  requiredAgentFacts: string[],
  machineEvidence: string[],
  agentNoiseCandidates: string[] = [],
): QaBrief {
  return { situation, agentNextDecision, humanQuestion, requiredAgentFacts, machineEvidence, agentNoiseCandidates };
}

test("captures real nine-tool results for agent, machine, and TUI QA", async () => {
  expect(spawnSync("bd", ["--version"], { stdio: "ignore" }).status, "headless QA requires the real Beads CLI").toBe(0);

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-tool-result-qa-"));
  const previousEnv = {
    HOME: process.env.HOME,
    PI_TEAM_NAME: process.env.PI_TEAM_NAME,
    PI_AGENT_NAME: process.env.PI_AGENT_NAME,
    PI_AGENT_LAUNCH_ID: process.env.PI_AGENT_LAUNCH_ID,
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
  };
  process.env.HOME = fakeHome;
  delete process.env.PI_TEAM_NAME;
  delete process.env.PI_AGENT_NAME;
  delete process.env.PI_AGENT_LAUNCH_ID;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  const cases: QaCase[] = [];
  const fixtureTransitions: QaBundle["fixtureTransitions"] = [];
  // Each call completes before the next starts, so the prior verified post-state
  // is the next call's pre-state. This removes redundant Beads snapshot reads.
  let previousSnapshot: unknown;

  try {
    // HOME must be isolated before these imports because PiTeams resolves its
    // authority roots at module initialization.
    const extension = (await import("../../extensions/index")).default;
    const paths = await import("../../src/utils/paths");
    const teams = await import("../../src/utils/teams");
    const tasks = await import("../../src/utils/tasks");
    const authorityAdapter = await import("../../src/model-tool-contract/beads-authority-adapter");
    const taskAdapter = await import("../../src/model-tool-contract/beads-task-adapter");
    const { DurableTaskMutationPublication } = await import("../../src/adapters/durable-task-mutation-publication");
    const { createTaskAuthorityTeamPort } = await import("../../test/support/task-authority-team-port");
    const { DurableTaskAuthorityRead } = await import("../../src/adapters/durable-task-authority-read");
    const { createReadOnlyBeadsTaskAdapterFactory } = await import("../../src/model-tool-contract/beads-task-adapter");
    const { DurableTaskAuthorityReadTeam } = await import("../../src/adapters/durable-task-authority-read-team");
    const { DurableGraphTaskAuthority } = await import("../../src/adapters/durable-graph-task-authority");
    const publicationPort = new DurableTaskMutationPublication();
    const graphTaskAuthority = new DurableGraphTaskAuthority();
    const taskAuthorityTeamPort = createTaskAuthorityTeamPort();
    const taskAuthorityReadTeamPort = new DurableTaskAuthorityReadTeam();
    const taskAuthorityRead = new DurableTaskAuthorityRead(taskAuthorityReadTeamPort);
    const taskReadFactory = createReadOnlyBeadsTaskAdapterFactory(taskAuthorityRead);
    const teamEvents = await import("../../src/utils/team-events");
    const terminalRegistry = await import("../../src/adapters/terminal-registry");

    const livePanes = new Map<string, boolean>([["qa-pane-lead", true]]);
    const unkillablePanes = new Set<string>();
    terminalRegistry.setAdapter({
      name: "qa-memory-terminal",
      detect: () => true,
      isDirectCarrier: () => true,
      currentTargetId: () => "qa-pane-lead",
      spawn: (options: { name: string }) => {
        const id = `qa-pane-${options.name}`;
        livePanes.set(id, true);
        return id;
      },
      kill: (id: string) => {
        if (!unkillablePanes.has(id)) livePanes.set(id, false);
      },
      isAlive: (id: string) => livePanes.get(id) === true,
      setTitle() {},
      supportsWindows: () => false,
      spawnWindow: () => { throw new Error("QA fixture does not use windows"); },
      setWindowTitle() {},
      killWindow: (id: string) => { livePanes.set(id, false); },
      isWindowAlive: (id: string) => livePanes.get(id) === true,
    });

    const teamName = "tool-result-qa";
    const leadSession = path.join(fakeHome, "sessions", "lead.jsonl");
    const workerSession = path.join(fakeHome, "sessions", "reviewer.jsonl");
    fs.mkdirSync(path.dirname(leadSession), { recursive: true });
    fs.writeFileSync(leadSession, "");
    fs.writeFileSync(workerSession, "");

    const branches = new Map<string, QaToolResultEntry[]>();

    function context(sessionFile: string) {
      const sessionId = `qa-${path.basename(sessionFile)}`;
      return {
        cwd: process.cwd(),
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => sessionFile,
          getBranch: () => branches.get(sessionId) ?? [],
          buildContextEntries: () => [],
          getEntries: () => [],
        },
        ui: {
          setStatus() {},
          notify() {},
          setTitle() {},
          setFooter() {},
        },
      };
    }

    function register(actor: "team-lead" | string, selectedTeam?: string) {
      const saved = {
        team: process.env.PI_TEAM_NAME,
        agent: process.env.PI_AGENT_NAME,
      };
      if (selectedTeam) process.env.PI_TEAM_NAME = selectedTeam;
      else delete process.env.PI_TEAM_NAME;
      if (actor === "team-lead") delete process.env.PI_AGENT_NAME;
      else process.env.PI_AGENT_NAME = actor;
      const tools = new Map<string, RegisteredTool>();
      const handlers = new Map<string, (event: any, ctx: any) => void | Promise<void>>();
      extension({
        registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
        on(event: string, handler: (event: any, ctx: any) => void | Promise<void>) { handlers.set(event, handler); },
        sendMessage() {},
        sendUserMessage() {},
        appendEntry() {},
      } as never);
      if (saved.team === undefined) delete process.env.PI_TEAM_NAME;
      else process.env.PI_TEAM_NAME = saved.team;
      if (saved.agent === undefined) delete process.env.PI_AGENT_NAME;
      else process.env.PI_AGENT_NAME = saved.agent;
      return { tools, handlers };
    }

    async function snapshot(): Promise<unknown> {
      if (!teams.teamExists(teamName)) return { team: { name: teamName, lifecycle: "absent" }, workers: [], tasks: [] };
      const [config, taskList] = await Promise.all([
        teams.readConfig(teamName),
        graphTaskAuthority.exists(teamName) ? graphTaskAuthority.readTasks(teamName) : tasks.listTasks(teamName, taskReadFactory),
      ]);
      return {
        team: {
          name: config.name,
          lifecycle: config.members.some((member) => member.isActive !== false) ? "active" : "shut_down",
          taskBackend: config.taskBackend,
        },
        workers: config.members
          .filter((member) => member.agentType === "teammate")
          .map((member) => ({
            name: member.name,
            membership: member.isActive === false ? "inactive" : "current",
            carrier: member.isActive === false ? "absent" : member.sessionFile ? "session_bound" : "prepared",
          })),
        tasks: taskList.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          assignee: task.assignee || null,
        })),
      };
    }

    const leadRegistration = register("team-lead");
    const leadTools = leadRegistration.tools;
    const leadCtx = context(leadSession);

    async function capture(options: {
      id: string;
      scenario: string;
      actor: string;
      tools: Map<string, RegisteredTool>;
      tool: string;
      args: Record<string, unknown>;
      ctx: unknown;
      qaBrief: QaBrief;
      signal?: AbortSignal;
    }): Promise<QaCase> {
      const tool = options.tools.get(options.tool);
      if (!tool) throw new Error(`Tool ${options.tool} is not registered for ${options.actor}`);
      const args = { ...options.args };
      if (options.actor === "team-lead") {
        if (options.tool === "task_read" && args.task_id && !args.task_ids) {
          args.task_ids = [args.task_id]; delete args.task_id; delete args.team_name;
        } else if (options.tool === "task_update") {
          delete args.team_name;
        } else if (options.tool === "team_sync" && !args.view) {
          args.view = args.cursor ? "updates" : "snapshot";
          delete args.team_name;
        } else if (["ensure_worker", "alert_send", "worker_stop"].includes(options.tool)) {
          delete args.team_name;
          delete args.cwd;
        }
      }
      for (const field of ["expected_version", "task_version"] as const) {
        if (typeof args[field] === "string" && !args[field].startsWith("v_")) {
          args[field] = taskVersionRef(args[field]);
        }
      }
      const handlers = options.actor === "team-lead" ? leadRegistration.handlers : undefined;
      const captured = await captureToolCase({
        ...options,
        args,
        tool,
        context: options.ctx,
        snapshot,
        before: previousSnapshot,
        beforeExecute: async () => {
          await handlers?.get("tool_call")?.({ toolName: options.tool }, options.ctx);
        },
        signal: options.signal,
        afterExecute: async (result) => {
          if (!handlers) return;
          const sessionId = (options.ctx as any).sessionManager.getSessionId();
          const entries = branches.get(sessionId) ?? [];
          entries.push({
            id: `qa-entry-${options.id}`,
            type: "message",
            message: { role: "toolResult", toolCallId: options.id, content: result.content },
          });
          branches.set(sessionId, entries);
          await handlers.get("before_provider_request")?.({ payload: result.content }, options.ctx);
        },
      });
      previousSnapshot = captured.oracle.after;
      cases.push(captured);
      return captured;
    }

    const detailsOf = (item: QaCase): any => item.projections.machine.details as any;

    // Each non-create public operation requires an exact leader Team binding.
    // Exercise the unavailable boundary through registered tools before setup.
    const unavailableCalls: Array<{ id: string; tool: string; args: Record<string, unknown> }> = [
      { id: "task-create-no-team", tool: "task_graph_apply", args: { operation_id: "qa-no-team-create", tasks: [{ key: "task", title: "Unavailable Task", goal: "Prove the unavailable Team boundary.", assignee: "unavailable-worker" }] } },
      { id: "task-read-no-team", tool: "task_read", args: { task_ids: ["unavailable-task"] } },
      { id: "task-update-no-team", tool: "task_update", args: { task_id: "unavailable-task", operation_id: "qa-no-team-update", expected_version: taskVersionRef("unavailable"), transition: "claim" } },
      { id: "sync-no-team", tool: "team_sync", args: { view: "snapshot" } },
      { id: "ensure-worker-no-team", tool: "ensure_worker", args: { name: "unavailable-worker", scope: "Prove unavailable Team binding." } },
      { id: "worker-stop-no-team", tool: "worker_stop", args: { worker: "unavailable-worker" } },
      { id: "team-shutdown-no-team", tool: "team_shutdown", args: {} },
      { id: "alert-no-team", tool: "alert_send", args: { to: "unavailable-worker", kind: "attention", text: "Prove unavailable Team binding." } },
    ];
    for (const unavailable of unavailableCalls) {
      await capture({
        ...unavailable,
        scenario: "unavailable-team-binding",
        actor: "team-lead",
        tools: leadTools,
        ctx: leadCtx,
        qaBrief: brief(
          "The exact leader Session has no active Team binding.",
          "Create or resume the correct Team before retrying.",
          "Did this call change state, and what must I do before retrying?",
          ["unavailable outcome", "no state changed", "active Team binding required"],
          ["unavailable reason", "state_changed false"],
        ),
      });
    }

    const postStateOf = (item: QaCase): any => {
      const details = detailsOf(item);
      if (details.postState) return details.postState;
      if (details.kind === "snapshot") return { ...details, cursor: String(details.head ?? "0"), journalHeadCursor: String(details.head ?? "0"), projection: details };
      if (details.kind === "updates") return { ...details, cursor: String(details.head ?? "0") };
      const graphTask = Object.values(details.tasks_by_key ?? {})[0] as any;
      if (graphTask) return { ...graphTask, description: graphTask.goal, acceptanceCriteria: graphTask.goal };
      if (details.task) return { ...details.task, description: details.task.goal, acceptanceCriteria: details.task.goal };
      const task = details.outcomes?.find((outcome: any) => outcome.task)?.task;
      if (task) return { ...task, description: task.goal, acceptanceCriteria: task.goal, relations: [] };
      if (details.task_id && details.version) return { ...details, id: details.task_id };
      return details;
    };
    const evidenceOf = (item: QaCase): any => detailsOf(item).evidence || {};

    await capture({
      id: "team-created",
      scenario: "team-and-worker-lifecycle",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_create",
      args: { name: teamName, purpose: "Headless projection QA fixture" },
      ctx: leadCtx,
      qaBrief: brief(
        "No Team exists; the call creates the durable Team, lead Membership, and Beads authority.",
        "Create a Worker or the first Task.",
        "Was the Team created and what can I do next?",
        ["created outcome", "Team name", "Task authority ready", "next action"],
        ["Team identity", "lead Membership identity", "Task authority identity"],
        ["opaque Membership UUID", "opaque Task-authority UUID"],
      ),
    });

    await capture({
      id: "team-create-current-refused",
      scenario: "team-and-worker-lifecycle",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_create",
      args: { name: teamName, purpose: "Must not replace the current Team" },
      ctx: leadCtx,
      qaBrief: brief(
        "The same Team still has current Memberships and must not be recreated implicitly.",
        "Continue with the current Team or shut it down explicitly before recreation.",
        "Why wasn't the existing Team replaced?",
        ["refused outcome", "current Memberships remain", "explicit shutdown action"],
        ["unchanged Team projection"],
        ["stack trace"],
      ),
    });

    await capture({
      id: "alert-zero-recipients",
      scenario: "alerts-and-empty-rosters",
      actor: "team-lead",
      tools: leadTools,
      tool: "alert_send",
      args: {
        team_name: teamName,
        to: "*",
        kind: "announcement",
        text: "This Team currently has no eligible Worker recipients.",
      },
      ctx: leadCtx,
      qaBrief: brief(
        "The Team has only its lead, so a whole-Team announcement has zero eligible Worker recipients.",
        "Do not treat the call as delivered; reconcile the roster before deciding whether a later retry is useful.",
        "Was this announcement delivered to anyone, and what should I check before retrying?",
        ["no eligible current recipient", "nothing delivered", "reconcile the roster before retrying"],
        ["unchanged Team", "no accepted delivery", "no Alert event cursor"],
        ["invented transport IDs"],
      ),
    });

    const startedWorker = await capture({
      id: "worker-started",
      scenario: "team-and-worker-lifecycle",
      actor: "team-lead",
      tools: leadTools,
      tool: "ensure_worker",
      args: {
        team_name: teamName,
        name: "reviewer",
        scope: "Review tool-result information sufficiency and excess.",
        cwd: process.cwd(),
      },
      ctx: leadCtx,
      qaBrief: brief(
        "The stable Worker does not exist; a fake terminal carrier is created but no Pi process starts.",
        "Assign work through a Task without assuming runtime readiness.",
        "Was the Worker created or reused, and was runtime readiness observed?",
        ["Worker name", "created outcome", "carrier prepared", "runtime not observed", "no Task assigned"],
        ["Membership identity", "terminal adapter and target", "runtime observation state"],
        ["Membership UUID", "pane ID"],
      ),
    });

    const workerMembership = (await teams.readConfig(teamName)).members.find((member) => member.name === "reviewer" && member.isActive !== false)!;
    const configBeforeBinding = await teams.readConfig(teamName);
    const prepared = [...configBeforeBinding.members].reverse().find((member) => member.name === "reviewer" && member.isActive !== false)!;
    const bound = await teams.bindMemberSession(
      teamName,
      "reviewer",
      workerSession,
      prepared.pendingLaunchId,
      prepared.terminalTarget ? { terminalTarget: prepared.terminalTarget } : { tmuxPaneId: prepared.tmuxPaneId },
      workerMembership.membershipId,
    );
    await teamEvents.appendTeamEvent(teamName, {
      type: "worker",
      worker: "reviewer",
      membershipId: bound.membershipId!,
      phase: "session_bound",
    });
    fixtureTransitions.push({
      action: "simulate Worker first-session binding without launching Pi",
      evidence: { worker: "reviewer", membershipId: bound.membershipId, sessionFile: path.relative(fakeHome, workerSession) },
    });

    await capture({
      id: "worker-reused",
      scenario: "team-and-worker-lifecycle",
      actor: "team-lead",
      tools: leadTools,
      tool: "ensure_worker",
      args: {
        team_name: teamName,
        name: "reviewer",
        scope: "Review tool-result information sufficiency and excess.",
        cwd: process.cwd(),
      },
      ctx: leadCtx,
      qaBrief: brief(
        "A current Session-bound Worker with this stable name already exists and owns no nonterminal Task.",
        "Reuse it by assigning another Task; do not replace or relaunch it.",
        "Did this reuse the existing idle Worker without disturbing it, and what should happen next?",
        ["Worker name", "reused outcome", "no relaunch", "assign work through a Task"],
        ["exact current Membership", "reuse receipt", "current carrier", "no lifecycle replacement"],
        ["full Member prompt", "absolute Session path", "Membership UUID"],
      ),
    });

    await capture({
      id: "worker-reserved-name-refused",
      scenario: "team-and-worker-lifecycle",
      actor: "team-lead",
      tools: leadTools,
      tool: "ensure_worker",
      args: {
        team_name: teamName,
        name: "team-lead",
        scope: "Must not shadow the coordinator.",
        cwd: process.cwd(),
      },
      ctx: leadCtx,
      qaBrief: brief(
        "The reserved coordinator identity is requested as a Worker.",
        "Choose a distinct stable Worker name.",
        "Why is this Worker name invalid?",
        ["refused outcome", "team-lead is reserved", "choose another name"],
        ["unchanged roster"],
      ),
    });

    await capture({
      id: "worker-stop-missing",
      scenario: "team-and-worker-lifecycle",
      actor: "team-lead",
      tools: leadTools,
      tool: "worker_stop",
      args: { team_name: teamName, worker: "missing-worker" },
      ctx: leadCtx,
      qaBrief: brief(
        "No current Worker exists under the requested stable name.",
        "Reconcile the roster with team_sync instead of assuming anything was stopped.",
        "Did this stop anything?",
        ["not found outcome", "Worker name", "no lifecycle mutation"],
        ["unchanged roster"],
      ),
    });

    const brokenTaskQueue = paths.taskDeliveryPath(teamName, "reviewer");
    fs.rmSync(brokenTaskQueue, { recursive: true, force: true });
    fs.mkdirSync(brokenTaskQueue, { recursive: true });
    fixtureTransitions.push({
      action: "replace one Task delivery queue file with a directory to force post-commit enqueue degradation",
      evidence: { worker: "reviewer", queuePath: path.relative(fakeHome, brokenTaskQueue) },
    });

    const initialGraph = await capture({
      id: "task-create-delivery-warning",
      scenario: "task-delivery-degradation",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_graph_apply",
      args: {
        operation_id: "qa-initial-graph",
        tasks: [
          {
            key: "projection-audit",
            title: "Audit tool result projections",
            goal: "Review each projection and report missing or excessive agent, machine, and human information.",
            assignee: "reviewer",
          },
          {
            key: "ambiguous-work",
            title: "Ambiguous assigned work",
            goal: "Record whether this goal alone is an independently verifiable success signal.",
            assignee: "reviewer",
            needs: ["projection-audit"],
          },
        ],
      },
      ctx: leadCtx,
      qaBrief: brief(
        "Graph authority commits two assigned Tasks, but deterministic queue corruption makes ready delivery fail after commit.",
        "Preserve the committed graph and investigate or retry delivery; never reapply it as if authority failed.",
        "Was the graph committed, which Task is ready, and did its Worker delivery succeed?",
        ["graph committed", "Task identities", "ready Task", "delivery degraded"],
        ["full committed graph", "graph version", "delivery warning"],
        ["queue path", "opaque recovery identifiers"],
      ),
    });

    fs.rmSync(brokenTaskQueue, { recursive: true, force: true });
    fixtureTransitions.push({
      action: "restore the Task delivery queue path after the deterministic enqueue failure",
      evidence: { worker: "reviewer" },
    });

    const workerTools = register("reviewer", teamName).tools;
    const workerCtx = context(workerSession);
    const initialGraphDetails = detailsOf(initialGraph);
    const taskCreated = initialGraphDetails.tasks_by_key["projection-audit"];
    const ambiguousTask = initialGraphDetails.tasks_by_key["ambiguous-work"];
    const createdTask = { ...initialGraph, id: "task-created-assigned" } as QaCase;
    const ambiguousCreatedTask = { ...initialGraph, id: "task-create-assigned-without-criteria-created" } as QaCase;
    cases.push(createdTask, ambiguousCreatedTask);

    const initialSync = await capture({
      id: "sync-snapshot",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_sync",
      args: { team_name: teamName },
      ctx: leadCtx,
      qaBrief: brief(
        "The lead requests a current snapshot, not event replay.",
        "Retain the cursor and decide whether current Workers and Tasks need action.",
        "What is current, and is anything immediately actionable?",
        ["next cursor", "Worker carrier phase", "Task title/status/assignee/version"],
        ["compact current projection", "cursor"],
        ["Task descriptions and notes", "Membership UUIDs"],
      ),
    });
    const initialCursor = postStateOf(initialSync).cursor;

    await capture({
      id: "sync-cancelled",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_sync",
      args: { team_name: teamName, cursor: initialCursor, event_types: ["task"] },
      ctx: leadCtx,
      signal: AbortSignal.abort(),
      qaBrief: brief(
        "No matching Task event arrives and the caller cancels its wait.",
        "Keep the observation base and decide whether another wait is useful; don't infer Worker failure.",
        "Did the cancelled wait advance observation state?",
        ["cancelled outcome", "no matching events", "no observation advance", "no runtime inference"],
        ["cancelled result", "unchanged observation base"],
      ),
    });

    const startedTask = await capture({
      id: "task-started",
      scenario: "task-lifecycle-and-events",
      actor: "reviewer",
      tools: workerTools,
      tool: "task_update",
      args: {
        team_name: teamName,
        task_id: taskCreated.id,
        operation_id: "qa-task-started",
        transition: "claim",
        expected_version: taskCreated.version,
      },
      ctx: workerCtx,
      qaBrief: brief(
        "The assigned Worker starts the Task with an exact-version write.",
        "Continue the work using the returned post-version.",
        "Did the Task start, and were there warnings?",
        ["Task ID", "in_progress status", "assignee", "new version", "warnings"],
        ["before and after Task", "applied operations", "delivery warnings"],
      ),
    });
    let currentTask = postStateOf(startedTask);


    await capture({
      id: "task-update-stale-version",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_update",
      args: {
        team_name: teamName,
        task_id: taskCreated.id,
        operation_id: "qa-task-update-stale-version",
        current_context: "This stale write must not land.",
        expected_version: taskCreated.version,
      },
      ctx: leadCtx,
      qaBrief: brief(
        "The caller attempts a conditional write using the pre-start Task version.",
        "Re-read the Task and retry against its current version.",
        "Was the stale edit rejected without changing the Task?",
        ["conflict outcome", "Task changed", "re-read and retry"],
        ["unchanged authoritative Task"],
        ["backend command detail"],
      ),
    });

    await capture({
      id: "task-terminal-without-evidence-execution-error",
      scenario: "task-lifecycle-and-events",
      actor: "reviewer",
      tools: workerTools,
      tool: "task_update",
      args: {
        team_name: teamName,
        task_id: taskCreated.id,
        operation_id: "qa-task-terminal-without-evidence",
        transition: "goal_achieved",
        expected_version: currentTask.version,
      },
      ctx: workerCtx,
      qaBrief: brief(
        "The Worker attempts to close work without a verification evidence note.",
        "Append concrete evidence in the same exact-version close update.",
        "Why didn't the Task close?",
        ["refused outcome", "evidence note required", "same-update guidance"],
        ["unchanged in-progress Task"],
      ),
    });

    const changedSync = await capture({
      id: "sync-task-change",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_sync",
      args: { team_name: teamName, cursor: initialCursor, wait_ms: 0 },
      ctx: leadCtx,
      qaBrief: brief(
        "A Task status event occurred after the lead's cursor.",
        "Decide whether the change needs intervention, another wait, or lifecycle action.",
        "Which Task changed, how, and who changed it?",
        ["next cursor", "Task ID", "change kind", "actor", "current Task version and state"],
        ["verbatim event reference", "compact projection", "changed Task hydration"],
        ["unrelated full Task bodies"],
      ),
    });
    let syncCursor = postStateOf(changedSync).cursor;

    expect(detailsOf(changedSync)).toMatchObject({ kind: "updates" });
    expect(detailsOf(changedSync).task_changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: taskCreated.id, current: expect.objectContaining({ status: "in_progress", version: currentTask.version }) }),
    ]));

    const malformedEvent = await teamEvents.appendTeamEvent(teamName, {
      type: "task",
      ref: { authorityId: (await teams.readConfig(teamName)).taskAuthorityId!, taskId: taskCreated.id, version: currentTask.version },
      change: "note",
      actor: "external-fixture",
    });
    fixtureTransitions.push({
      action: "append one legacy-shaped Task event without taskEvidence to verify fail-closed updates recovery",
      evidence: { taskId: taskCreated.id, eventId: `task-event-${malformedEvent.cursor}` },
    });
    const evidenceGap = await capture({
      id: "sync-task-evidence-gap",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_sync",
      args: { team_name: teamName, cursor: syncCursor, wait_ms: 0 },
      ctx: leadCtx,
      qaBrief: brief(
        "A legacy-shaped Task event has no typed journal evidence.",
        "Do not advance the cursor; request a snapshot to recover authoritative current state.",
        "Did updates fail closed, and what recovery is safe?",
        ["contract gap", "structured Task evidence absent", "snapshot recovery"],
        ["unchanged observation cursor", "malformed event identity"],
      ),
    });
    expect(detailsOf(evidenceGap)).toMatchObject({
      kind: "contract_gap",
      reason: "structured_task_event_evidence_absent",
      state_changed: false,
      observation_advanced: false,
    });
    expect(evidenceGap.projections.model.text).toContain("structured_task_event_evidence_absent");

    const recoveredSync = await capture({
      id: "sync-task-evidence-gap-recovery",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_sync",
      args: { team_name: teamName },
      ctx: leadCtx,
      qaBrief: brief(
        "Updates stopped at malformed historical Task evidence.",
        "Use the snapshot as the new observation base before requesting later updates.",
        "Did the snapshot restore current state without replaying malformed evidence?",
        ["snapshot", "current Task state", "new cursor"],
        ["snapshot cursor", "current Task projection"],
      ),
    });
    syncCursor = postStateOf(recoveredSync).cursor;

    for (let index = 0; index < 80; index += 1) {
      await teamEvents.appendTeamEvent(teamName, {
        type: "worker",
        worker: "reviewer",
        membershipId: bound.membershipId!,
        phase: "failed",
      });
    }
    fixtureTransitions.push({
      action: "append a deterministic burst of compact Worker events beyond the intended response budget",
      evidence: { worker: "reviewer", eventCount: 80, afterCursor: syncCursor },
    });

    const overflowSync = await capture({
      id: "sync-event-overflow",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_sync",
      args: { team_name: teamName, cursor: syncCursor, wait_ms: 0, event_types: ["worker"], limit: 20 },
      ctx: leadCtx,
      qaBrief: brief(
        "Eighty compact Worker events accumulated after the caller's cursor, beyond a reasonable one-result response budget.",
        "Inspect the bounded batch, retain the continuation cursor, and continue only if more events remain.",
        "Was the event page truncated, how large is this page, and where do I continue?",
        ["page truncated", "bounded returned count", "stable continuation cursor", "grouped semantic event summary"],
        ["bounded event records", "journal head", "returned cursor", "truncation evidence", "current bounded projection"],
        ["all overflow events", "repeated equivalent summaries"],
      ),
    });
    syncCursor = postStateOf(overflowSync).cursor;
    const drainedOverflow = teamEvents.readTeamEvents(teamName, {
      afterCursor: syncCursor,
      eventTypes: ["worker"],
      limit: teamEvents.MAX_TEAM_SYNC_LIMIT,
    });
    fixtureTransitions.push({
      action: "consume the remaining synthetic overflow page before later semantic-event scenarios",
      evidence: {
        fromCursor: syncCursor,
        throughCursor: drainedOverflow.cursor,
        returned: drainedOverflow.events.length,
        truncated: drainedOverflow.truncated,
      },
    });
    syncCursor = drainedOverflow.cursor;

    await capture({
      id: "task-read-full",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_read",
      args: { team_name: teamName, task_id: taskCreated.id },
      ctx: leadCtx,
      qaBrief: brief(
        "The lead intentionally requests the full current Task contract.",
        "Review its intent/evidence or use its version for a conditional write.",
        "Can I understand the Task contract and its current state without parsing noise?",
        ["title", "description", "acceptance criteria", "design", "notes", "status", "assignee", "relations", "version"],
        ["full structured Task", "provenance"],
        ["redundant scoped provenance in agent prose"],
      ),
    });

    await capture({
      id: "task-read-not-found",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_read",
      args: { team_name: teamName, task_id: "missing-task" },
      ctx: leadCtx,
      qaBrief: brief(
        "The requested Task ID is not present in this Team's authority.",
        "Check the ID or current projection; don't fabricate a Task.",
        "Was a Task found?",
        ["not found outcome", "requested Task ID", "check current authority"],
        ["no fabricated Task details", "unchanged Task authority"],
      ),
    });

    await capture({
      id: "blocker-created",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_graph_apply",
      args: {
        operation_id: "qa-add-scoring-threshold",
        expected_graph_version: initialGraphDetails.graph_version,
        tasks: [
          {
            key: "projection-audit",
            title: "Audit tool result projections",
            goal: "Review each projection and report missing or excessive agent, machine, and human information.",
            assignee: "reviewer",
          },
          {
            key: "ambiguous-work",
            title: "Ambiguous assigned work",
            goal: "Record whether this goal alone is an independently verifiable success signal.",
            assignee: "reviewer",
            needs: ["projection-audit"],
          },
          {
            key: "scoring-threshold",
            title: "Decide QA scoring threshold",
            goal: "Choose and record the minimum evidence needed for an acceptable projection.",
            assignee: "reviewer",
            needs: ["projection-audit"],
          },
        ],
      },
      ctx: leadCtx,
      qaBrief: brief(
        "A second unassigned Task will become an explicit blocker.",
        "Use its ID in the relation mutation.",
        "What was created?",
        ["Task ID", "status", "version"],
        ["full Task post-state"],
      ),
    });

    await capture({
      id: "alert-task-clarification",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "alert_send",
      args: {
        team_name: teamName,
        to: "reviewer",
        kind: "clarification",
        text: "Treat transport identifiers as machine evidence, not agent guidance.",
        task_id: currentTask.id,
        task_version: currentTask.version,
      },
      ctx: leadCtx,
      qaBrief: brief(
        "A Task-referenced exceptional clarification is accepted for native delivery.",
        "Know whether delivery was accepted; durable Task state is unchanged.",
        "Was the clarification sent to the intended Worker, and did it change the Task?",
        ["clarification kind", "recipient", "Task ref", "accepted or partial outcome", "failures"],
        ["Alert ID", "event cursor", "Message delivery IDs", "recipient failures"],
        ["Alert UUID", "Message UUID", "journal cursor"],
      ),
    });

    await capture({
      id: "alert-invalid-team-target",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "alert_send",
      args: {
        team_name: teamName,
        to: "*",
        kind: "clarification",
        text: "This invalid fan-out must not be accepted.",
      },
      ctx: leadCtx,
      qaBrief: brief(
        "A clarification incorrectly targets the whole Team.",
        "Send it to one current member, or use announcement for lead-only fan-out.",
        "Why wasn't this Alert broadcast?",
        ["validation outcome", "only announcements target the Team", "allowed correction"],
        ["no Alert event", "no delivery accepted"],
      ),
    });

    await capture({
      id: "alert-missing-recipient",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "alert_send",
      args: {
        team_name: teamName,
        to: "missing-worker",
        kind: "attention",
        text: "This recipient does not exist.",
      },
      ctx: leadCtx,
      qaBrief: brief(
        "A directed Alert names no current Team member.",
        "Use team_sync to reconcile the roster, then choose a current recipient.",
        "Was anyone alerted?",
        ["recipient not current", "no accepted Alert", "reconcile roster"],
        ["no Alert event", "unchanged Team"],
      ),
    });

    await capture({
      id: "announcement-peer-started",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "ensure_worker",
      args: {
        team_name: teamName,
        name: "delivery-broken",
        scope: "Exercise partial Alert and shutdown outcomes.",
        cwd: process.cwd(),
      },
      ctx: leadCtx,
      qaBrief: brief(
        "A second current Worker gives announcement fan-out more than one delivery outcome.",
        "Assign a Task only if real work exists; otherwise leave it idle for the declared edge case and reconcile it later.",
        "Was the additional Worker carrier created?",
        ["Worker created", "runtime not observed", "no Task assigned"],
        ["Membership and terminal target"],
      ),
    });

    const brokenInbox = paths.inboxPath(teamName, "delivery-broken");
    fs.rmSync(brokenInbox, { force: true });
    fs.mkdirSync(brokenInbox, { recursive: true });
    fixtureTransitions.push({
      action: "replace one Alert delivery queue file with a directory to force a partial announcement",
      evidence: { worker: "delivery-broken", queuePath: path.relative(fakeHome, brokenInbox) },
    });

    await capture({
      id: "alert-announcement-partial",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "alert_send",
      args: {
        team_name: teamName,
        to: "*",
        kind: "announcement",
        text: "Projection QA is entering lifecycle cleanup.",
      },
      ctx: leadCtx,
      qaBrief: brief(
        "A lead-only announcement reaches one current Worker while another delivery queue fails.",
        "Inspect the named failure; don't equate partial delivery with Task or Team state change.",
        "Who accepted the announcement and who did not?",
        ["partial outcome", "accepted recipients", "failed recipients", "no Task mutation"],
        ["Alert ID", "Alert event cursor", "accepted Message IDs", "per-recipient failure"],
        ["opaque Alert and Message IDs"],
      ),
    });

    await capture({
      id: "worker-stop-refused",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "worker_stop",
      args: { team_name: teamName, worker: "reviewer" },
      ctx: leadCtx,
      qaBrief: brief(
        "The Worker still owns one in-progress Task, so the lifecycle guard refuses the stop.",
        "Close, block and unassign, or reassign the named Task before retrying.",
        "Why was the stop refused and what must change?",
        ["refused outcome", "Worker name", "guarding Task IDs", "allowed next actions"],
        ["structured refusal code", "guarding Task refs", "unchanged Membership state"],
        ["stack trace", "unrelated runtime state"],
      ),
    });

    const blockedTask = await capture({
      id: "task-blocked-unassigned",
      scenario: "relations-alerts-and-guards",
      actor: "reviewer",
      tools: workerTools,
      tool: "task_update",
      args: {
        team_name: teamName,
        task_id: currentTask.id,
        operation_id: "qa-task-blocked-unassigned",
        transition: "block",
        current_context: "Blocked on the QA scoring threshold; next action: team-lead chooses the threshold.",
        evidence: "The scoring threshold is absent; team-lead must choose it before work continues.",
        expected_version: currentTask.version,
      },
      ctx: workerCtx,
      qaBrief: brief(
        "The Worker records blocker evidence in one authoritative mutation.",
        "The lead must resolve the blocker before reassigning; the Worker can now be stopped.",
        "What changed, what is the blocker, and who acts next?",
        ["blocked status", "current owner", "new version", "warnings", "evidence/next action acknowledgement"],
        ["before and after Task", "appended note", "delivery warnings"],
      ),
    });
    currentTask = postStateOf(blockedTask);

    const finalSync = await capture({
      id: "sync-multiple-changes",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_sync",
      args: { team_name: teamName, cursor: syncCursor, wait_ms: 0, task_ids: [currentTask.id] },
      ctx: leadCtx,
      qaBrief: brief(
        "Relation, Alert, and blocked/unassigned events occurred after the prior cursor.",
        "Resolve the blocker or stop the now-idle Worker, then continue from the new cursor.",
        "What changed since the cursor, and which item needs my attention?",
        ["new cursor", "semantic events", "current requested Task", "blocked/unassigned state"],
        ["filtered event records", "requested Task hydration", "compact Worker projection"],
        ["unrequested Task bodies"],
      ),
    });
    syncCursor = postStateOf(finalSync).cursor;
    expect(syncCursor).toEqual(expect.any(String));

    await capture({
      id: "worker-stopped",
      scenario: "lifecycle-closure",
      actor: "team-lead",
      tools: leadTools,
      tool: "worker_stop",
      args: { team_name: teamName, worker: "reviewer" },
      ctx: leadCtx,
      qaBrief: brief(
        "The Worker owns no nonterminal Task and its fake pane can be stopped exactly.",
        "Reuse another current Worker or create one only when new work exists.",
        "Was the Worker stopped, and were Tasks left untouched?",
        ["stopped outcome", "Worker name", "no Task state changed"],
        ["deactivated Membership ID", "exact terminal stop evidence", "receipt"],
        ["Membership jargon"],
      ),
    });

    await capture({
      id: "idle-worker-started",
      scenario: "lifecycle-closure",
      actor: "team-lead",
      tools: leadTools,
      tool: "ensure_worker",
      args: {
        team_name: teamName,
        name: "idle-reviewer",
        scope: "Available for future projection QA.",
        cwd: process.cwd(),
      },
      ctx: leadCtx,
      qaBrief: brief(
        "A second Worker carrier exists with no assigned Tasks, to exercise whole-Team shutdown.",
        "Either assign a Task or close the Team.",
        "What lifecycle resource was created?",
        ["Worker name", "created outcome", "runtime not observed"],
        ["Membership and terminal launch evidence"],
        ["opaque identifiers"],
      ),
    });

    unkillablePanes.add("qa-pane-delivery-broken");
    fixtureTransitions.push({
      action: "make one fake terminal pane refuse its first kill to force partial Team shutdown",
      evidence: { worker: "delivery-broken", pane: "qa-pane-delivery-broken" },
    });

    await capture({
      id: "team-shutdown-partial",
      scenario: "lifecycle-closure",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_shutdown",
      args: { team_name: teamName },
      ctx: leadCtx,
      qaBrief: brief(
        "One idle Worker stops, but one fake terminal refuses shutdown, so the lead remains current for recovery.",
        "Resolve the named stop failure and retry Team shutdown.",
        "Which Worker stopped, which one failed, and can the lead retry?",
        ["partial lifecycle", "deactivated Workers", "named failure", "lead retained", "retry action", "Task authority retained"],
        ["exact stop evidence", "failure evidence", "partial-shutdown receipt"],
        ["absolute Session paths", "pane IDs"],
      ),
    });

    unkillablePanes.delete("qa-pane-delivery-broken");
    fixtureTransitions.push({
      action: "allow the previously stuck fake pane to stop before retrying Team shutdown",
      evidence: { worker: "delivery-broken" },
    });

    await capture({
      id: "team-shutdown",
      scenario: "lifecycle-closure",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_shutdown",
      args: { team_name: teamName },
      ctx: leadCtx,
      qaBrief: brief(
        "The Team has one idle Worker carrier and retained blocked/unassigned Task evidence.",
        "Stop coordinating; retain the Task authority for external inspection.",
        "Did shutdown finish, what failed, and is Task history retained?",
        ["final lifecycle", "stopped Worker count", "Task authority retained", "named failures", "next action on partial failure"],
        ["deactivated Memberships", "exact stop evidence", "failure evidence", "retained authority"],
        ["absolute Session paths", "pane IDs", "Membership UUIDs"],
      ),
    });

    const publicTools = [...leadTools.keys()].sort();
    expect(publicTools).toEqual([
      "alert_send",
      "ensure_worker",
      "task_graph_apply",
      "task_read",
      "task_update",
      "team_create",
      "team_shutdown",
      "team_sync",
      "worker_stop",
    ]);
    expect(new Set(cases.map((item) => item.call.tool))).toEqual(new Set(publicTools));
    const domainRefusalCaseIds = [
      "team-create-current-refused",
      "alert-zero-recipients",
      "worker-reserved-name-refused",
      "worker-stop-missing",
      "task-update-stale-version",
      "task-terminal-without-evidence-execution-error",
      "alert-invalid-team-target",
      "alert-missing-recipient",
      "worker-stop-refused",
    ];
    for (const id of domainRefusalCaseIds) {
      const item = cases.find((candidate) => candidate.id === id)!;
      if (item.execution.threw) expect(item.execution.isError, id).toBe(true);
      else {
        const details = detailsOf(item);
        if (Array.isArray(details.outcomes)) expect(details.outcomes.some((outcome: any) => /refused|unavailable/.test(outcome.kind)), id).toBe(true);
        else if (details.outcome) expect(details, id).toMatchObject({ outcome: expect.stringMatching(/refused|partial/) });
        else expect(details, id).toMatchObject({ kind: expect.stringMatching(/refused|unavailable/) });
      }
    }
    for (const item of cases.filter((candidate) => !candidate.execution.threw)) {
      const details = detailsOf(item);
      expect(details, item.id).toMatchObject({ kind: expect.any(String) });
    }
    expect(cases).toHaveLength(42);
    const caseAfter = (id: string) => cases.find((item) => item.id === id)?.oracle.after as any;
    expect(caseAfter("alert-zero-recipients")).toEqual(
      cases.find((item) => item.id === "alert-zero-recipients")?.oracle.before,
    );
    expect(caseAfter("task-create-delivery-warning").tasks).toContainEqual(expect.objectContaining({
      title: "Audit tool result projections",
      status: "ready",
      assignee: "reviewer",
    }));
    expect(caseAfter("task-created-assigned").tasks).toContainEqual(expect.objectContaining({
      title: "Audit tool result projections",
      status: "ready",
      assignee: "reviewer",
    }));
    expect(caseAfter("task-started").tasks).toContainEqual(expect.objectContaining({
      title: "Audit tool result projections",
      status: "in_progress",
      assignee: "reviewer",
    }));
    expect(caseAfter("worker-stop-refused")).toEqual(
      cases.find((item) => item.id === "worker-stop-refused")?.oracle.before,
    );
    expect(caseAfter("task-blocked-unassigned").tasks).toContainEqual(expect.objectContaining({
      title: "Audit tool result projections",
      status: "blocked",
      assignee: "reviewer",
    }));
    const stoppedCase = cases.find((item) => item.id === "worker-stopped")!;
    if (stoppedCase.projections.machine.details?.schema) {
      expect(caseAfter("worker-stopped").workers).toContainEqual(expect.objectContaining({ name: "reviewer", membership: "inactive" }));
    } else {
      expect(detailsOf(stoppedCase)).toMatchObject({ kind: expect.stringMatching(/worker_stopped|refused|unavailable/) });
      expect(caseAfter("worker-stopped").workers).toContainEqual(expect.objectContaining({ name: "reviewer", membership: "current" }));
    }
    const overflowDetails = detailsOf(cases.find((item) => item.id === "sync-event-overflow")!);
    if (overflowDetails.schema) {
      expect(evidenceOf(cases.find((item) => item.id === "sync-event-overflow")!).events).toHaveLength(20);
      expect(postStateOf(cases.find((item) => item.id === "sync-event-overflow")!)).toMatchObject({ journalHeadCursor: expect.any(String), pagination: { events: { limit: 20, returned: 20, truncated: true, continuationCursor: expect.any(String) } } });
    } else expect(overflowDetails).toMatchObject({ kind: expect.stringMatching(/snapshot|updates|unavailable|contract_gap/) });
    expect(caseAfter("sync-event-overflow")).toEqual(
      cases.find((item) => item.id === "sync-event-overflow")?.oracle.before,
    );
    const alertPartial = detailsOf(cases.find((item) => item.id === "alert-announcement-partial")!);
    if (alertPartial.schema) expect(alertPartial).toMatchObject({ outcome: "partial", postState: { kind: "announcement", taskStateChanged: false }, evidence: expect.anything() });
    else expect(alertPartial).toMatchObject({ kind: expect.stringMatching(/alert_sent|refused|unavailable/) });
    const shutdownPartial = detailsOf(cases.find((item) => item.id === "team-shutdown-partial")!);
    if (shutdownPartial.schema) expect(shutdownPartial).toMatchObject({ outcome: "partial", postState: { lifecycle: "active", taskAuthorityRetained: true }, evidence: expect.anything() });
    else expect(shutdownPartial).toMatchObject({ kind: expect.stringMatching(/partial|team_shutdown|unavailable/) });
    const partialAfter = caseAfter("team-shutdown-partial");
    expect(partialAfter.workers).toContainEqual(expect.objectContaining({ name: "delivery-broken", membership: "current" }));
    expect(cases.at(-1)?.oracle.after).toMatchObject({ team: { lifecycle: expect.stringMatching(/shut_down|active/) } });

    // These presentation checks use decision facts from the registered outcome,
    // not the model projection oracle. Each fact must survive both TUI modes.
    const semanticTuiCases: Array<{
      id: string;
      facts: (item: QaCase) => string[];
    }> = [
      {
        id: "task-created-assigned",
        facts: () => ["partial", "2 Task graph committed", "1 ready", "qa-initial-graph", "delivery failed"],
      },
      {
        id: "task-update-stale-version",
        facts: (item) => {
          const outcome = detailsOf(item);
          return ["refused", outcome.reason, `retry at version ${outcome.current_task.version}`];
        },
      },
      {
        id: "alert-announcement-partial",
        facts: () => ["partial", "reviewer", "failed recipients: delivery-broken", "Task state unchanged"],
      },
      {
        id: "task-read-no-team",
        facts: () => ["unavailable", "no_active_team"],
      },
      {
        id: "task-terminal-without-evidence-execution-error",
        facts: () => ["refused", "evidence_required", "evidence must not be empty"],
      },
    ];
    for (const semanticCase of semanticTuiCases) {
      const item = cases.find((candidate) => candidate.id === semanticCase.id)!;
      for (const projection of [item.projections.human.compact, item.projections.human.expanded]) {
        for (const fact of semanticCase.facts(item)) expect(projection, `${semanticCase.id}: ${fact}`).toContain(fact);
      }
    }

    const trioCoverage = [
      ["team_create", "team-created"],
      ["task_graph_apply", "task-created-assigned"],
      ["task_read", "task-read-full"],
      ["task_update", "task-started"],
      ["team_sync", "sync-snapshot"],
      ["ensure_worker", "worker-started"],
      ["worker_stop", "worker-stopped"],
      ["team_shutdown", "team-shutdown"],
      ["alert_send", "alert-task-clarification"],
    ] as const;
    const privatePresentationValues = [fakeHome, leadSession, workerSession, "qa-pane-"];
    for (const [tool, successCase] of trioCoverage) {
      expect(cases.find((item) => item.id === successCase)?.call.tool).toBe(tool);
    }
    for (const unavailable of unavailableCalls) {
      const item = cases.find((candidate) => candidate.id === unavailable.id)!;
      expect(item.execution.threw, unavailable.id).toBe(false);
      const details = detailsOf(item);
      if (Array.isArray(details.outcomes)) {
        expect(details.outcomes).toEqual([expect.objectContaining({ kind: "unavailable", state_changed: false })]);
      } else {
        expect(details, unavailable.id).toMatchObject({ kind: "unavailable", state_changed: false });
      }
    }
    for (const item of cases) {
      expect(item.projections.human.compact, item.id).not.toBe("");
      expect(item.projections.human.expanded, item.id).not.toBe("");
      if (!item.execution.threw) {
        expect(item.execution, item.id).toEqual({ threw: false, isError: false });
        const raw = detailsOf(item);
        const model = JSON.parse(item.projections.model.text);
        // This is the parity oracle: raw semantic truth produces exactly the
        // agent JSON from the registered tool, including recovery coordinates.
        expect(model, item.id).toEqual(projectToolResult(item.call.tool, raw));
      } else {
        expect(item.execution.isError, item.id).toBe(true);
        expect(item.projections.model.text, item.id).not.toBe("");
      }
      for (const privateValue of privatePresentationValues) {
        expect(item.projections.model.text, item.id).not.toContain(privateValue);
        expect(item.projections.human.compact, item.id).not.toContain(privateValue);
        expect(item.projections.human.expanded, item.id).not.toContain(privateValue);
      }
    }

    const qaPromptPath = path.join(process.cwd(), "scripts", "tool-result-qa", "QA-PROMPT.md");
    writeQaBundle(outputPath, {
      schema: "pi-teams-tool-result-qa/2",
      projectionVersion: "2",
      generatedAt: new Date().toISOString(),
      source: {
        extension: "extensions/index.ts",
        scenarios: "scripts/tool-result-qa/suite.test.ts",
        rubric: "scripts/tool-result-qa/QA-PROMPT.md",
      },
      executionBoundary: {
        piProcessLaunched: false,
        modelInvoked: false,
        realTaskAuthority: "beads",
        terminal: "in-memory adapter",
      },
      fixtureTransitions,
      cases,
      qaPrompt: fs.readFileSync(qaPromptPath, "utf8"),
    });

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8")).cases).toHaveLength(cases.length);
    process.stdout.write(`\nPiTeams tool-result QA bundle: ${outputPath}\n`);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}, 600_000);
