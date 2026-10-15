import { writeJsonFixture } from "./test-write-json";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import piTeams from "../../extensions/index";
import * as paths from "./paths";
import * as teams from "./teams";

type Tool = { name: string; parameters: unknown; execute: (...args: any[]) => Promise<any> };
const created: string[] = [];

async function fixture() {
  const name = `worker-graph-version-${process.pid}-${Date.now()}-${created.length}`;
  created.push(name);
  const leadSession = `/tmp/${name}-lead.jsonl`;
  const workerSession = `/tmp/${name}-worker.jsonl`;
  await teams.createTeam(name, leadSession, `lead@${name}`);
  const config = await teams.readConfig(name);
  config.logicalWorkers = [{ name: "worker", scope: "Complete the graph Task." }];
  writeJsonFixture(paths.configPath(name), config);
  await teams.addMember(name, {
    membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate",
    joinedAt: Date.now(), cwd: process.cwd(), subscriptions: [], sessionFile: workerSession, isActive: true,
  });
  const register = (actor: string) => {
    vi.stubEnv("PI_TEAM_NAME", name);
    vi.stubEnv("PI_AGENT_NAME", actor === "team-lead" ? "" : actor);
    const tools = new Map<string, Tool>();
    piTeams({ registerTool(tool: Tool) { tools.set(tool.name, tool); }, on() {}, sendMessage: vi.fn(), appendEntry: vi.fn() } as never);
    return tools;
  };
  const context = (sessionFile: string) => ({ sessionManager: { getSessionFile: () => sessionFile, buildContextEntries: () => [] }, ui: { setStatus: vi.fn(), notify: vi.fn() } });
  return { name, leadSession, workerSession, register, context };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of created.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
});

describe("Worker Task graph version boundary", () => {
  it("preserves opaque graph versions across read, claim, and stale CAS refusal", async () => {
    const f = await fixture();
    const lead = f.register("team-lead");
    const worker = f.register("worker");
    expect([...lead.keys()].sort()).toEqual(["alert_send", "ensure_worker", "task_graph_apply", "task_read", "task_update", "team_create", "team_shutdown", "team_sync", "worker_stop"]);
    expect([...worker.keys()].sort()).toEqual(["alert_send", "task_read", "task_update"]);
    const create = lead.get("task_graph_apply")!;
    const update = worker.get("task_update")!;
    const read = worker.get("task_read")!;

    expect(Check(update.parameters as any, {
      task_id: "task-1", operation_id: "claim-version-safe", transition: "claim", expected_version: "v_0000000000000000",
    })).toBe(true);
    expect(Check(update.parameters as any, {
      task_id: "task-1", operation_id: "no-op-version-safe", expected_version: "v_0000000000000000",
    })).toBe(false);
    expect(Check(update.parameters as any, {
      team_name: f.name, task_id: "task-1", operation_id: "unexpected-team", transition: "claim", expected_version: "v_0000000000000000",
    })).toBe(false);

    const created = await create.execute("create", {
      operation_id: "create-version-safe", tasks: [{ key: "work", title: "Version-safe mutation", goal: "Prove Worker graph CAS.", assignee: "worker" }],
    }, undefined, undefined, f.context(f.leadSession));
    const task = created.details.tasks_by_key.work;
    const readResult = await read.execute("read", { task_id: task.id }, undefined, undefined, f.context(f.workerSession));
    const modelVersion = JSON.parse(readResult.content[0].text).task.version;
    expect(modelVersion).toBe(task.version);
    expect(modelVersion).toMatch(/^v_[0-9a-f]{16}$/);

    const claimed = await update.execute("claim", {
      task_id: task.id, operation_id: "worker-claim", transition: "claim", expected_version: modelVersion,
    }, undefined, undefined, f.context(f.workerSession));
    expect(claimed.details).toMatchObject({ kind: "updated", transition: "claim", task: { id: task.id, status: "in_progress" } });
    expect(claimed.details.task.version).toMatch(/^v_[0-9a-f]{16}$/);
    expect(claimed.details.task.version).not.toBe(modelVersion);

    const stale = await update.execute("stale", {
      task_id: task.id, operation_id: "stale-claim", transition: "goal_achieved", evidence: "Must refuse stale version.", expected_version: modelVersion,
    }, undefined, undefined, f.context(f.workerSession));
    expect(stale.details).toMatchObject({ kind: "refused", reason: "version_conflict", task_id: task.id, state_changed: false });
  }, 60_000);
});
