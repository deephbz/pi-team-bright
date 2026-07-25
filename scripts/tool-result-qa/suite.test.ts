import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
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

test("captures real ten-tool results for agent, machine, and TUI QA", async () => {
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

  try {
    // HOME must be isolated before these imports because PiTeams resolves its
    // authority roots at module initialization.
    const extension = (await import("../../extensions/index")).default;
    const paths = await import("../../src/utils/paths");
    const teams = await import("../../src/utils/teams");
    const tasks = await import("../../src/utils/tasks");
    const teamEvents = await import("../../src/utils/team-events");
    const terminalRegistry = await import("../../src/adapters/terminal-registry");

    const livePanes = new Map<string, boolean>();
    const unkillablePanes = new Set<string>();
    terminalRegistry.setAdapter({
      name: "qa-memory-terminal",
      detect: () => true,
      isDirectCarrier: () => true,
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

    function context(sessionFile: string) {
      return {
        cwd: process.cwd(),
        sessionManager: {
          getSessionFile: () => sessionFile,
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

    function register(actor: "team-lead" | string, selectedTeam?: string): Map<string, RegisteredTool> {
      const saved = {
        team: process.env.PI_TEAM_NAME,
        agent: process.env.PI_AGENT_NAME,
      };
      if (selectedTeam) process.env.PI_TEAM_NAME = selectedTeam;
      else delete process.env.PI_TEAM_NAME;
      if (actor === "team-lead") delete process.env.PI_AGENT_NAME;
      else process.env.PI_AGENT_NAME = actor;
      const registered = new Map<string, RegisteredTool>();
      extension({
        registerTool(tool: RegisteredTool) { registered.set(tool.name, tool); },
        on() {},
        sendMessage() {},
        sendUserMessage() {},
        appendEntry() {},
      } as never);
      if (saved.team === undefined) delete process.env.PI_TEAM_NAME;
      else process.env.PI_TEAM_NAME = saved.team;
      if (saved.agent === undefined) delete process.env.PI_AGENT_NAME;
      else process.env.PI_AGENT_NAME = saved.agent;
      return registered;
    }

    async function snapshot(): Promise<unknown> {
      if (!teams.teamExists(teamName)) return { team: { name: teamName, lifecycle: "absent" }, workers: [], tasks: [] };
      const [config, taskList] = await Promise.all([teams.readConfig(teamName), tasks.listTasks(teamName)]);
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
          relationCount: task.relations.length,
        })),
      };
    }

    const leadTools = register("team-lead");
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
    }): Promise<QaCase> {
      const tool = options.tools.get(options.tool);
      if (!tool) throw new Error(`Tool ${options.tool} is not registered for ${options.actor}`);
      const captured = await captureToolCase({ ...options, tool, context: options.ctx, snapshot });
      cases.push(captured);
      return captured;
    }

    const detailsOf = (item: QaCase): any => item.projections.machine.details as any;
    const postStateOf = (item: QaCase): any => detailsOf(item).postState;
    const evidenceOf = (item: QaCase): any => detailsOf(item).evidence;

    await capture({
      id: "team-created",
      scenario: "team-and-worker-lifecycle",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_create",
      args: { team_name: teamName, description: "Headless projection QA fixture" },
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
      args: { team_name: teamName, description: "Must not replace the current Team" },
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
      tool: "worker_ensure",
      args: {
        team_name: teamName,
        name: "reviewer",
        profile: "Review tool-result information sufficiency and excess.",
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

    const workerMembership = evidenceOf(startedWorker);
    const configBeforeBinding = await teams.readConfig(teamName);
    const prepared = [...configBeforeBinding.members].reverse().find((member) => member.name === "reviewer" && member.isActive !== false)!;
    const bound = await teams.bindMemberSession(
      teamName,
      "reviewer",
      workerSession,
      prepared.pendingLaunchId,
      { tmuxPaneId: prepared.tmuxPaneId },
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
      evidence: { worker: "reviewer", membershipId: bound.membershipId, sessionFile: workerSession },
    });

    await capture({
      id: "worker-reused",
      scenario: "team-and-worker-lifecycle",
      actor: "team-lead",
      tools: leadTools,
      tool: "worker_ensure",
      args: {
        team_name: teamName,
        name: "reviewer",
        profile: "Review tool-result information sufficiency and excess.",
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
      tool: "worker_ensure",
      args: {
        team_name: teamName,
        name: "team-lead",
        profile: "Must not shadow the coordinator.",
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
      evidence: { worker: "reviewer", queuePath: brokenTaskQueue },
    });

    const deliveryWarningTask = await capture({
      id: "task-create-delivery-warning",
      scenario: "task-delivery-degradation",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_create",
      args: {
        team_name: teamName,
        title: "Capture task-create delivery degradation",
        description: "Create authoritative assigned work while its native delivery queue is unavailable.",
        acceptance_criteria: "The Task exists in Beads and the receipt distinguishes committed authority from degraded delivery.",
        assignee: "reviewer",
      },
      ctx: leadCtx,
      qaBrief: brief(
        "Beads accepts an assigned Task, but deterministic queue corruption makes native delivery enqueue fail after commit.",
        "Preserve the committed Task and investigate or retry delivery; never recreate the Task as if authority failed.",
        "Was the Task created, and did its Worker delivery succeed?",
        ["Task created authoritatively", "assignee", "authority committed", "delivery degraded"],
        ["full committed Task", "applied create operation", "delivery warning", "delivery-degraded evidence"],
        ["queue path", "opaque recovery identifiers"],
      ),
    });

    fs.rmSync(brokenTaskQueue, { recursive: true, force: true });
    fixtureTransitions.push({
      action: "restore the Task delivery queue path after the deterministic enqueue failure",
      evidence: { worker: "reviewer" },
    });
    const leadMembership = (await teams.readConfig(teamName)).members.find((member) => member.name === "team-lead" && member.isActive !== false)!;
    const deliveryWarningTaskState = postStateOf(deliveryWarningTask);
    const clearedDeliveryWarningTask = await tasks.applySemanticTaskUpdate(teamName, deliveryWarningTaskState.id, {
      status: "blocked",
      assignee: "",
      appendNote: "QA fixture cleanup: delivery degradation was captured; the Worker is released from this synthetic Task.",
    }, {
      actor: "team-lead",
      expectedVersion: deliveryWarningTaskState.version,
      actingSessionFile: leadSession,
      actingMembershipId: leadMembership.membershipId,
    });
    fixtureTransitions.push({
      action: "release the Worker from the synthetic delivery-warning Task through real Task authority",
      evidence: {
        taskId: clearedDeliveryWarningTask.task.id,
        status: clearedDeliveryWarningTask.task.status,
        assignee: clearedDeliveryWarningTask.task.assignee ?? null,
      },
    });

    const workerTools = register("reviewer", teamName);
    const workerCtx = context(workerSession);
    const createdTask = await capture({
      id: "task-created-assigned",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_create",
      args: {
        team_name: teamName,
        title: "Audit tool result projections",
        description: "Review each projection without changing the extension implementation.",
        acceptance_criteria: "Report missing and excessive information for agent, machine, and human audiences.",
        assignee: "reviewer",
      },
      ctx: leadCtx,
      qaBrief: brief(
        "A goal-driven Task is created and assigned to the current Worker.",
        "Do not re-read it; wait for or act on later state changes.",
        "What Task was created, for whom, and in what state?",
        ["Task ID", "created status", "assignee", "write version"],
        ["full authoritative Task post-state"],
        ["constant create operation", "full Task body"],
      ),
    });
    const taskCreated = postStateOf(createdTask);

    await capture({
      id: "task-create-assigned-without-criteria-refused",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_create",
      args: {
        team_name: teamName,
        title: "Ambiguous assigned work",
        description: "This intentionally lacks independently verifiable success criteria.",
        assignee: "reviewer",
      },
      ctx: leadCtx,
      qaBrief: brief(
        "An assigned Task omits required acceptance criteria.",
        "Add independently verifiable acceptance criteria and retry.",
        "Why wasn't this assigned work accepted?",
        ["refused outcome", "acceptance criteria required", "retry guidance"],
        ["no Task created"],
      ),
    });

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
      id: "sync-timeout",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_sync",
      args: { team_name: teamName, cursor: initialCursor, wait_ms: 5, event_types: ["task"] },
      ctx: leadCtx,
      qaBrief: brief(
        "No matching Task event arrives during a bounded event-driven wait.",
        "Keep the returned cursor and choose whether another wait is worthwhile; don't infer Worker failure.",
        "Did anything change before the wait ended?",
        ["timed out outcome", "no matching events", "current cursor", "no runtime inference"],
        ["timeout flag", "current compact projection"],
      ),
    });

    const futureCursor = (BigInt(initialCursor) + 10_000n).toString();
    await capture({
      id: "sync-future-cursor",
      scenario: "task-lifecycle-and-events",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_sync",
      args: { team_name: teamName, cursor: futureCursor, wait_ms: 0 },
      ctx: leadCtx,
      qaBrief: brief(
        "The requested cursor is a valid decimal but lies beyond the current Team event journal head.",
        "Reject the coordinate without treating a lower head as successful progress, then request a fresh snapshot.",
        "Why was this cursor refused, and how do I establish a usable coordinate?",
        ["future cursor refused", "no state change", "lower head isn't continuation success", "request a fresh snapshot"],
        ["requested cursor", "current journal head", "no wait or mutation"],
        ["journal implementation detail"],
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
        status: "in_progress",
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
        design: "This stale write must not land.",
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
      id: "task-terminal-without-evidence-refused",
      scenario: "task-lifecycle-and-events",
      actor: "reviewer",
      tools: workerTools,
      tool: "task_update",
      args: {
        team_name: teamName,
        task_id: taskCreated.id,
        status: "closed",
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

    const blockerCreated = await capture({
      id: "blocker-created",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_create",
      args: {
        team_name: teamName,
        title: "Decide QA scoring threshold",
        description: "Choose the minimum evidence needed for an acceptable projection.",
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
    const blocker = postStateOf(blockerCreated);

    const linkedTask = await capture({
      id: "task-linked",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_link",
      args: {
        team_name: teamName,
        task_id: currentTask.id,
        relation: "blocked_by",
        target_id: blocker.id,
        action: "add",
        expected_version: currentTask.version,
      },
      ctx: leadCtx,
      qaBrief: brief(
        "The primary Task gains one typed blocked_by relation.",
        "Continue using the new version or inspect/wait; do not infer status changed.",
        "Which relation was added between which Tasks?",
        ["source Task", "add action", "blocked_by relation", "target Task", "new version"],
        ["graph mutation result", "authoritative source Task ID and version", "resulting typed relations"],
        ["unchanged assignee and status unless needed to disambiguate"],
      ),
    });
    currentTask = postStateOf(linkedTask);

    await capture({
      id: "task-link-stale-version",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_link",
      args: {
        team_name: teamName,
        task_id: currentTask.id,
        relation: "blocked_by",
        target_id: blocker.id,
        action: "remove",
        expected_version: taskCreated.version,
      },
      ctx: leadCtx,
      qaBrief: brief(
        "A relation mutation uses a Task version from before later status and graph changes.",
        "Re-read the source Task and retry the graph mutation with its current version.",
        "Was the stale graph edit rejected?",
        ["conflict outcome", "source Task changed", "relation remains"],
        ["unchanged graph projection"],
      ),
    });

    const removedLink = await capture({
      id: "task-link-removed",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_link",
      args: {
        team_name: teamName,
        task_id: currentTask.id,
        relation: "blocked_by",
        target_id: blocker.id,
        action: "remove",
        expected_version: currentTask.version,
      },
      ctx: leadCtx,
      qaBrief: brief(
        "The existing blocked_by edge is removed with the current source version.",
        "Use the returned Task version for any next graph mutation.",
        "Which relation was removed?",
        ["source Task", "remove action", "blocked_by relation", "target Task", "new version"],
        ["authoritative relation-free Task post-state"],
      ),
    });
    currentTask = postStateOf(removedLink);

    const relinkedTask = await capture({
      id: "task-link-readded",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_link",
      args: {
        team_name: teamName,
        task_id: currentTask.id,
        relation: "blocked_by",
        target_id: blocker.id,
        action: "add",
        expected_version: currentTask.version,
      },
      ctx: leadCtx,
      qaBrief: brief(
        "The removed blocked_by edge is restored with the latest source version.",
        "Continue from the returned version; don't reuse either prior graph token.",
        "Was the typed relation restored?",
        ["source Task", "add action", "target Task", "new version"],
        ["authoritative Task with one relation"],
      ),
    });
    currentTask = postStateOf(relinkedTask);

    const duplicateLink = await capture({
      id: "task-link-duplicate",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "task_link",
      args: {
        team_name: teamName,
        task_id: currentTask.id,
        relation: "blocked_by",
        target_id: blocker.id,
        action: "add",
        expected_version: currentTask.version,
      },
      ctx: leadCtx,
      qaBrief: brief(
        "The requested blocked_by edge already exists at the supplied current Task version.",
        "Treat the request as an idempotent no-op and continue from the unchanged Task version; don't imply a new mutation or delivery.",
        "Did this add another relation, change the Task, or trigger Task-change delivery?",
        ["relation already existed", "no-op outcome", "no version change"],
        ["empty applied operations", "unchanged Task and relation graph", "delivery not degraded"],
        ["success wording that implies a new edge"],
      ),
    });
    currentTask = postStateOf(duplicateLink);

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
      tool: "worker_ensure",
      args: {
        team_name: teamName,
        name: "delivery-broken",
        profile: "Exercise partial Alert and shutdown outcomes.",
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
      evidence: { worker: "delivery-broken", queuePath: brokenInbox },
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
        status: "blocked",
        assignee: "",
        append_note: "Blocked on the QA scoring threshold; next action: team-lead chooses the threshold and reassigns the Task.",
        expected_version: currentTask.version,
      },
      ctx: workerCtx,
      qaBrief: brief(
        "The Worker records blocker evidence and releases ownership in one authoritative mutation.",
        "The lead must resolve the blocker before reassigning; the Worker can now be stopped.",
        "What changed, what is the blocker, and who acts next?",
        ["blocked status", "unassigned owner", "new version", "warnings", "evidence/next action acknowledgement"],
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
      id: "sync-invalid-cursor",
      scenario: "relations-alerts-and-guards",
      actor: "team-lead",
      tools: leadTools,
      tool: "team_sync",
      args: { team_name: teamName, cursor: "not-a-cursor", wait_ms: 0 },
      ctx: leadCtx,
      qaBrief: brief(
        "The caller supplies a malformed Team event cursor.",
        "Reuse the last cursor returned by team_sync instead of inventing one.",
        "Why couldn't Team changes be replayed?",
        ["invalid cursor outcome", "cursor must be monotonic decimal", "reuse returned cursor"],
        ["no state mutation"],
      ),
    });

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
      tool: "worker_ensure",
      args: {
        team_name: teamName,
        name: "idle-reviewer",
        profile: "Available for future projection QA.",
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
      "task_create",
      "task_link",
      "task_read",
      "task_update",
      "team_create",
      "team_shutdown",
      "team_sync",
      "worker_ensure",
      "worker_stop",
    ]);
    expect(new Set(cases.map((item) => item.call.tool))).toEqual(new Set(publicTools));
    const domainRefusalCaseIds = [
      "team-create-current-refused",
      "alert-zero-recipients",
      "worker-reserved-name-refused",
      "worker-stop-missing",
      "task-create-assigned-without-criteria-refused",
      "task-update-stale-version",
      "task-terminal-without-evidence-refused",
      "task-read-not-found",
      "task-link-stale-version",
      "alert-invalid-team-target",
      "alert-missing-recipient",
      "worker-stop-refused",
      "sync-invalid-cursor",
      "sync-future-cursor",
    ];
    for (const id of domainRefusalCaseIds) {
      const item = cases.find((candidate) => candidate.id === id)!;
      if (item.execution.threw) expect(item.execution.isError, id).toBe(true);
      else expect(detailsOf(item), id).toMatchObject({ schema: "pi-teams-tool-result/1", outcome: "refused" });
    }
    const executionErrorCaseIds: string[] = [];
    for (const id of executionErrorCaseIds) {
      expect(cases.find((item) => item.id === id)?.execution, id).toEqual({ threw: true, isError: true });
    }
    for (const item of cases.filter((candidate) => !candidate.execution.threw)) {
      expect(detailsOf(item), item.id).toMatchObject({ schema: "pi-teams-tool-result/1" });
      expect(Array.isArray(detailsOf(item).warnings), `${item.id}:warnings`).toBe(true);
      expect(Array.isArray(detailsOf(item).nextActions), `${item.id}:nextActions`).toBe(true);
    }
    expect(cases).toHaveLength(39);
    const caseAfter = (id: string) => cases.find((item) => item.id === id)?.oracle.after as any;
    expect(caseAfter("alert-zero-recipients")).toEqual(
      cases.find((item) => item.id === "alert-zero-recipients")?.oracle.before,
    );
    expect(caseAfter("task-create-delivery-warning").tasks).toContainEqual(expect.objectContaining({
      title: "Capture task-create delivery degradation",
      status: "open",
      assignee: "reviewer",
    }));
    expect(caseAfter("task-created-assigned").tasks).toContainEqual(expect.objectContaining({
      title: "Audit tool result projections",
      status: "open",
      assignee: "reviewer",
    }));
    expect(caseAfter("task-started").tasks).toContainEqual(expect.objectContaining({
      title: "Audit tool result projections",
      status: "in_progress",
      assignee: "reviewer",
    }));
    expect(caseAfter("task-linked").tasks).toContainEqual(expect.objectContaining({
      title: "Audit tool result projections",
      relationCount: 1,
    }));
    expect(caseAfter("task-link-removed").tasks).toContainEqual(expect.objectContaining({
      title: "Audit tool result projections",
      relationCount: 0,
    }));
    expect(caseAfter("task-link-readded").tasks).toContainEqual(expect.objectContaining({
      title: "Audit tool result projections",
      relationCount: 1,
    }));
    expect(caseAfter("task-link-duplicate")).toEqual(
      cases.find((item) => item.id === "task-link-duplicate")?.oracle.before,
    );
    expect(evidenceOf(cases.find((item) => item.id === "task-link-duplicate")!)).toMatchObject({
      appliedOperations: [],
      deliveryDegraded: false,
    });
    expect(caseAfter("worker-stop-refused")).toEqual(
      cases.find((item) => item.id === "worker-stop-refused")?.oracle.before,
    );
    expect(caseAfter("task-blocked-unassigned").tasks).toContainEqual(expect.objectContaining({
      title: "Audit tool result projections",
      status: "blocked",
      assignee: null,
    }));
    expect(caseAfter("worker-stopped").workers).toContainEqual(expect.objectContaining({
      name: "reviewer",
      membership: "inactive",
    }));
    expect(postStateOf(cases.find((item) => item.id === "sync-timeout")!)).toMatchObject({
      cursor: expect.any(String),
      completion: "timeout",
    });
    expect(caseAfter("sync-future-cursor")).toEqual(
      cases.find((item) => item.id === "sync-future-cursor")?.oracle.before,
    );
    expect(evidenceOf(cases.find((item) => item.id === "sync-event-overflow")!).events).toHaveLength(20);
    expect(postStateOf(cases.find((item) => item.id === "sync-event-overflow")!)).toMatchObject({
      journalHeadCursor: expect.any(String),
      pagination: {
        events: {
          limit: 20,
          returned: 20,
          truncated: true,
          continuationCursor: expect.any(String),
        },
      },
    });
    expect(caseAfter("sync-event-overflow")).toEqual(
      cases.find((item) => item.id === "sync-event-overflow")?.oracle.before,
    );
    expect(detailsOf(cases.find((item) => item.id === "alert-announcement-partial")!)).toMatchObject({
      outcome: "partial",
      postState: {
        kind: "announcement",
        to: "*",
        recipients: expect.arrayContaining(["reviewer"]),
        taskStateChanged: false,
      },
      warnings: expect.arrayContaining([expect.objectContaining({
        code: "alert_delivery_failed",
        resourceId: "delivery-broken",
      })]),
      evidence: expect.anything(),
    });
    expect(detailsOf(cases.find((item) => item.id === "team-shutdown-partial")!)).toMatchObject({
      outcome: "partial",
      postState: {
        lifecycle: "active",
        shutdownOutcome: "partial",
        taskAuthorityRetained: true,
        failures: expect.arrayContaining([expect.objectContaining({ name: "delivery-broken" })]),
      },
      evidence: expect.anything(),
    });
    expect(caseAfter("team-shutdown-partial").workers).toContainEqual(expect.objectContaining({
      name: "delivery-broken",
      membership: "current",
    }));
    expect(cases.at(-1)?.oracle.after).toMatchObject({ team: { lifecycle: "shut_down" } });

    const qaPromptPath = path.join(process.cwd(), "scripts", "tool-result-qa", "QA-PROMPT.md");
    writeQaBundle(outputPath, {
      schema: "pi-teams-tool-result-qa/1",
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
}, 300_000);
