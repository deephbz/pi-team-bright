import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ControlledProcess, createIsolatedWorkspace } from "../../test/support/external-harness";

type PublicResult = {
  pid: number;
  registered: string[];
  results: Array<{ name: string; details: any; text: string }>;
  entries: any[];
};

const packageRoot = process.cwd();
const childScript = path.join(packageRoot, "test/support/formal-hardening-public-child.cjs");

describe("registered Task tools across process loss", () => {
  it("recovers committed graph state, replay receipts, and downstream dispatch", async () => {
    const isolated = createIsolatedWorkspace("formal-public-recovery-");
    const teamName = `formal-recovery-${process.pid}-${Date.now()}`;
    const teamRoot = path.join(isolated.home, ".pi", "teams", teamName);
    const leaderSession = path.join(isolated.home, "leader.jsonl");
    const workerASession = path.join(isolated.home, "worker-a.jsonl");
    const workerBSession = path.join(isolated.home, "worker-b.jsonl");
    const graphFile = path.join(teamRoot, "task-authority", "graph-control.json");
    const eventFile = path.join(teamRoot, "events", "team-events.jsonl");
    fs.mkdirSync(teamRoot, { recursive: true });
    fs.writeFileSync(path.join(teamRoot, "config.json"), JSON.stringify({
      name: teamName,
      description: "Isolated public-tool recovery evidence.",
      createdAt: Date.now(),
      epochId: `epoch-${teamName}`,
      leadAgentId: `team-lead@${teamName}`,
      leadSessionId: leaderSession,
      logicalWorkers: ["worker-a", "worker-b"].map((name) => ({ name, scope: `Own ${name} work.` })),
      members: [
        { name: "team-lead", agentType: "lead", sessionFile: leaderSession },
        { name: "worker-a", agentType: "teammate", sessionFile: workerASession },
        { name: "worker-b", agentType: "teammate", sessionFile: workerBSession },
      ].map((member, index) => ({
        ...member,
        membershipId: `membership-${index}-${teamName}`,
        agentId: `${member.name}@${teamName}`,
        joinedAt: Date.now() + index,
        tmuxPaneId: "",
        cwd: packageRoot,
        subscriptions: [],
        isActive: true,
      })),
    }));

    let commandIndex = 0;
    let leaderEntries: any[] = [];
    async function run(actor: "team-lead" | "worker-a" | "worker-b", calls: Array<{ name: string; id: string; params: object; ack?: boolean }>, crash: boolean): Promise<PublicResult> {
      const command = isolated.write(`command-${++commandIndex}.json`, JSON.stringify({
        cwd: packageRoot,
        sessionFile: actor === "team-lead" ? leaderSession : actor === "worker-a" ? workerASession : workerBSession,
        entries: actor === "team-lead" ? leaderEntries : [],
        calls,
        hold: crash,
      }));
      const processRun = new ControlledProcess({
        command: process.execPath,
        args: [childScript, command],
        cwd: packageRoot,
        env: isolated.childEnvironment({
          PI_TEAM_NAME: actor === "team-lead" ? "" : teamName,
          PI_AGENT_NAME: actor === "team-lead" ? "" : actor,
          PI_TEAMS_TASK_POLL_MS: "600000",
        }),
        timeoutMs: 45_000,
      }).start();
      try {
        const output = await processRun.waitForOutput("FORMAL_RESULT ", { timeoutMs: 45_000 });
        const line = output.split("\n").find((candidate) => candidate.startsWith("FORMAL_RESULT "));
        expect(line, output).toBeDefined();
        const result = JSON.parse(line!.slice("FORMAL_RESULT ".length)) as PublicResult;
        if (actor === "team-lead") leaderEntries = result.entries;
        if (crash) {
          const exit = await processRun.crash("SIGKILL", 10_000);
          expect(exit.signal).toBe("SIGKILL");
        } else {
          const exit = await processRun.waitForExit(10_000);
          expect(exit.code, exit.stderr).toBe(0);
        }
        return result;
      } finally {
        if (processRun.running) await processRun.crash("SIGKILL", 10_000);
      }
    }

    try {
      const graph = {
        operation_id: "formal-apply-1",
        tasks: [
          { key: "source", title: "Produce source", goal: "Produce a checked source result.", assignee: "worker-a" },
          { key: "consumer", title: "Consume source", goal: "Use the accepted source result.", assignee: "worker-b", needs: ["source"] },
        ],
      };
      const applied = await run("team-lead", [{ name: "task_graph_apply", id: "apply", params: graph }], true);
      expect(applied.registered).toContain("task_graph_apply");
      const receipt = applied.results[0].details;
      expect(receipt).toMatchObject({
        kind: "task_graph_applied",
        replayed: false,
        ready_task_ids: ["source"],
        tasks_by_key: {
          source: { status: "ready" },
          consumer: { status: "dependency_waiting" },
        },
      });
      expect(fs.existsSync(graphFile)).toBe(true);
      const committedGraph = fs.readFileSync(graphFile, "utf8");
      const publishedEvents = fs.readFileSync(eventFile, "utf8");

      const reopened = await run("team-lead", [
        { name: "task_graph_apply", id: "replay", params: graph },
        { name: "task_read", id: "read", params: { task_ids: ["source", "consumer"] } },
        { name: "team_sync", id: "sync", params: { view: "snapshot" }, ack: true },
      ], false);
      expect(reopened.pid).not.toBe(applied.pid);
      expect(reopened.results[0].details).toMatchObject({ kind: "task_graph_applied", replayed: true });
      expect(reopened.results[1].details).toMatchObject({
        kind: "task_read_batch",
        outcomes: [
          { kind: "found", task: { id: "source", status: "ready" } },
          { kind: "found", task: { id: "consumer", status: "dependency_waiting" } },
        ],
      });
      expect(reopened.results[2].details.kind).toBe("snapshot");
      expect(fs.readFileSync(graphFile, "utf8")).toBe(committedGraph);
      expect(fs.readFileSync(eventFile, "utf8")).toBe(publishedEvents);

      const sourceVersion = receipt.tasks_by_key.source.version;
      const claimed = await run("worker-a", [{ name: "task_update", id: "claim", params: {
        task_id: "source", operation_id: "formal-claim-1", transition: "claim", expected_version: sourceVersion,
      } }], true);
      expect(claimed.results[0].details).toMatchObject({
        kind: "updated", task: { id: "source", status: "in_progress" }, replayed: false,
      });
      const claimVersion = claimed.results[0].details.task.version;
      const achieved = await run("worker-a", [{ name: "task_update", id: "achieve", params: {
        task_id: "source", operation_id: "formal-achieve-1", transition: "goal_achieved",
        expected_version: claimVersion, evidence: "Source result passed its acceptance check.",
      } }], true);
      expect(achieved.results[0].details).toMatchObject({
        kind: "updated", task: { id: "source", status: "goal_achieved" }, ready_task_ids: ["consumer"],
      });

      // An incomplete authority read must leave the acknowledged position in place.
      const committedAfterAchieve = fs.readFileSync(graphFile, "utf8");
      fs.writeFileSync(graphFile, "{");
      try {
        const partial = await run("team-lead", [
          { name: "team_sync", id: "partial-sync", params: { view: "updates" } },
        ], false);
        expect(partial.results[0].details).toMatchObject({ kind: "unavailable", reason: "task_authority_unavailable" });
      } finally {
        fs.writeFileSync(graphFile, committedAfterAchieve);
      }

      const recovered = await run("team-lead", [
        { name: "task_read", id: "recovered-read", params: { task_ids: ["source", "consumer"] } },
        { name: "team_sync", id: "recovered-sync", params: { view: "updates" } },
      ], false);
      expect(recovered.results[0].details).toMatchObject({
        kind: "task_read_batch",
        outcomes: [
          { kind: "found", task: { id: "source", status: "goal_achieved" } },
          { kind: "found", task: { id: "consumer", status: "ready" } },
        ],
      });
      expect(recovered.results[1].details.kind).toBe("updates");
      const source = recovered.results[0].details.outcomes[0].task;
      const consumer = recovered.results[0].details.outcomes[1].task;
      const consumerClaim = await run("worker-b", [{ name: "task_update", id: "consumer-claim", params: {
        task_id: "consumer", operation_id: "formal-consumer-claim-1", transition: "claim",
        expected_version: consumer.version,
      } }], false);
      expect(consumerClaim.results[0].details).toMatchObject({
        kind: "updated",
        task: { id: "consumer", status: "in_progress", current_attempt: { input_attempt_ids: { source: source.accepted_attempt_id } } },
      });
      const currentGraph = fs.readFileSync(graphFile, "utf8");
      const stale = await run("worker-a", [{ name: "task_update", id: "stale", params: {
        task_id: "source", operation_id: "formal-stale-1", transition: "goal_achieved",
        expected_version: claimVersion, evidence: "A stale process must not repeat the outcome.",
      } }], false);
      expect(stale.results[0].details).toMatchObject({ kind: "refused", reason: "version_conflict", state_changed: false });
      expect(fs.readFileSync(graphFile, "utf8")).toBe(currentGraph);
      const events = fs.readFileSync(eventFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "task", ref: { taskId: "source", version: source.version } }),
        expect.objectContaining({ type: "task", ref: { taskId: "consumer", version: consumerClaim.results[0].details.task.version } }),
      ]));
    } finally {
      isolated.cleanup();
    }
  }, 180_000);
});
