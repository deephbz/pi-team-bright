import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SimActor } from "./actor";
import { loadActorExtension } from "./actor-loader";
import { SimWorld } from "./world";

// This immutable C0 revision writes the legacy store. No hand-written runtime fixture.
const BASELINE = "14d92fdc2c7cf0b21f6853ba495d828350901e03";
const names = ["lead", "w1", "w2", "w3"];
const team = "team-1";

async function migrationWorld() {
  const root = path.resolve("dist/sim-migration-baseline", BASELINE);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const archive = execFileSync("git", ["archive", BASELINE, "src", "extensions", "package.json"], { maxBuffer: 32 * 1024 * 1024 });
  execFileSync("tar", ["--exclude=*.test.*", "-xf", "-", "-C", root], { input: archive });
  const legacy = new Map<string, Awaited<ReturnType<typeof loadActorExtension>>>();
  const current = new Map<string, Awaited<ReturnType<typeof loadActorExtension>>>();
  for (const name of names) {
    const variables = { PI_AGENT_NAME: name === "lead" ? "team-lead" : name };
    legacy.set(name, await loadActorExtension(variables, root));
    current.set(name, await loadActorExtension(variables));
  }
  const world = new SimWorld(42);
  const actors = new Map<string, SimActor>();
  let factories = legacy;
  const add = (name: string, variables: Record<string, string> = {}) => {
    const id = `${team}/${name}`;
    const oldEnv = world.envs.get(id);
    if (oldEnv && !world.processes.exists(oldEnv.process.pid)) world.envs.delete(id);
    const actor = new SimActor(world, id, { PI_AGENT_NAME: name === "lead" ? "team-lead" : name, ...variables });
    actor.initialize(factories.get(name)!);
    actors.set(name, actor);
    return actor;
  };
  world.herdr.onStart = pane => {
    const name = pane.env.PI_AGENT_NAME!;
    world.scheduler.enqueue(`boot:${name}`, () => add(name, { ...pane.env, HERDR_PANE_ID: pane.id }).emit("session_start", { reason: "startup" }));
  };
  async function run<T>(action: () => Promise<T>): Promise<T> {
    let result: T | undefined;
    let finished = false;
    world.scheduler.enqueue("migration.input", async () => { result = await action(); finished = true; });
    for (let count = 0; !finished && count < 10000; count++) {
      if (!await world.scheduler.step(true)) throw new Error("Migration input has no completion");
    }
    if (!finished) throw new Error("Migration input exceeded schedule bound");
    await world.drain();
    return result!;
  }
  const tool = (name: string, tool: string, args: Record<string, unknown>) => run(() => actors.get(name)!.tool(tool, args)) as Promise<any>;
  const disk = (file: string) => path.join(world.workspace.home, ".pi/teams", team, file);
  const runtime = (name: string) => JSON.parse(fs.readFileSync(disk(`runtime/${name}.json`), "utf8"));
  const journal = () => fs.readFileSync(disk("events/team-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  async function reload(name: string) {
    if (name === "lead") factories = current;
    const old = actors.get(name)!;
    await run(() => old.emit("session_shutdown", { reason: "reload" }));
    const actor = new SimActor(world, old.id, {}, old.session.getSessionFile());
    // Reload replaces extensions; it does not settle an ongoing native turn.
    actor.idle = old.idle;
    actor.initialize(current.get(name)!);
    actors.set(name, actor);
    await run(() => actor.emit("session_start", { reason: "reload" }));
  }
  try {
    add("lead");
    await run(() => actors.get("lead")!.emit("session_start", { reason: "startup" }));
    expect((await tool("lead", "team_create", { name: team, purpose: "Synthetic migration verification" })).details.kind).toBe("team_created");
    for (const name of names.slice(1)) {
      expect((await tool("lead", "ensure_worker", { name, scope: `Scope ${name}` })).details.kind).toBe("worker_ensured");
    }
    const graph = (await tool("lead", "task_graph_apply", { operation_id: "graph", tasks: names.slice(1).map(name => ({ key: name, title: `Work ${name}`, goal: "Preserve this Attempt during migration", assignee: name })) })).details;
    const tasks: Record<string, any> = {};
    for (const name of names.slice(1)) {
      const card = graph.tasks_by_key[name];
      const result = await tool(name, "task_update", { task_id: card.id, operation_id: `claim-${name}`, expected_version: card.version, transition: "claim" });
      expect(result.details.kind).toBe("updated");
      tasks[name] = result.details.task;
      expect(tasks[name].status).toBe("in_progress");
      expect(tasks[name].current_attempt.id).toBeTruthy();
      expect(tasks[name].attempts_started).toBe(1);
      expect(runtime(name).osBirthToken).toBeUndefined();
    }
    // Populate exactly 50 committed events through the baseline Task authority.
    while (journal().length < 50) {
      const result = await tool("w1", "task_update", { task_id: tasks.w1.id, operation_id: `progress-${journal().length}`, expected_version: tasks.w1.version, current_context: `Baseline progress ${journal().length}` });
      expect(result.details.kind).toBe("updated");
      tasks.w1 = result.details.task;
    }
    expect(journal()).toHaveLength(50);
    return { world, actors, tool, run, reload, runtime, journal, disk, tasks };
  } catch (error) { world.dispose(); throw error; }
}

it("migrates a baseline Team lead first, then three Workers without replacing a Session or carrier", async () => {
  const h = await migrationWorld();
  try {
    const sessions = new Map([...h.actors].map(([name, actor]) => [name, actor.session.getSessionId()]));
    const branches = new Map([...h.actors].map(([name, actor]) => [name, actor.session.getBranch()]));
    const runtime = new Map(names.slice(1).map(name => [name, h.runtime(name)]));
    const start = h.world.history.length;
    const remaining = new Set(names.slice(1));
    async function checkCarriers(since: number) {
      const target = h.world.scheduler.now + 2000;
      while ((h.world.scheduler.nextDue() ?? Infinity) <= target) await h.world.scheduler.step(true);
      await h.world.drain();
      for (const name of names.slice(1)) {
        const result = (await h.tool("lead", "ensure_worker", { name, scope: `Scope ${name}` })).details;
        expect(result).toMatchObject(remaining.has(name)
          ? { kind: "attention", reason: "unknown", nextActionHint: "wait" }
          : { kind: "worker_ensured", effect: "reused" });
      }
      // Terminal wait hints are informational. Human-action hints must never
      // target a Worker whose reload completed successfully.
      for (const event of h.journal().slice(since)) {
        if (["ask_human", "ensure_worker"].includes(event.carrier?.nextActionHint)) expect(remaining.has(event.worker)).toBe(true);
      }
    }
    await h.reload("lead");
    const sync = await h.tool("lead", "team_sync", { view: "updates" });
    expect(sync.details).toMatchObject({ kind: "snapshot", observation: { from: 0, through: Number(h.journal().at(-1).cursor) } });
    expect(sync.details.observation.through).toBeGreaterThanOrEqual(50);
    expect(sync.details.task_changes).toBeUndefined();
    expect(sync.details.worker_changes).toBeUndefined();
    expect(sync.details.team_changes).toBeUndefined();
    expect(sync.details.tasks).toHaveLength(3);
    expect(sync.details.tasks.every((task: any) => task.status === "in_progress")).toBe(true);
    expect(h.actors.get("lead")!.session.getSessionId()).toBe(sessions.get("lead"));
    expect(h.actors.get("lead")!.session.getBranch()).toEqual(expect.arrayContaining(branches.get("lead")!));
    await checkCarriers(50);
    for (const name of names.slice(1)) {
      const since = h.journal().length;
      await h.reload(name);
      remaining.delete(name);
      expect(h.actors.get(name)!.session.getBranch()).toEqual(expect.arrayContaining(branches.get(name)!));
      expect(h.runtime(name)).toMatchObject({ pid: runtime.get(name).pid, membershipId: runtime.get(name).membershipId });
      expect(h.actors.get(name)!.session.getSessionId()).toBe(sessions.get(name));
      expect(h.runtime(name).osBirthToken).toBe(h.world.processes.actor(`${team}/${name}`)!.osBirthToken);
      expect(h.runtime(name).lastStop).toBeUndefined();
      expect((await h.tool("lead", "ensure_worker", { name, scope: `Scope ${name}` })).details).toMatchObject({ kind: "worker_ensured", effect: "reused" });
      const update = await h.tool(name, "task_update", { task_id: h.tasks[name].id, operation_id: `migrated-${name}`, expected_version: h.tasks[name].version, current_context: "Resumed the exact Task Attempt" });
      expect(update.details.task.current_attempt).toEqual(h.tasks[name].current_attempt);
      expect(update.details.task.attempts_started).toBe(1);
      await checkCarriers(since);
    }
    expect(remaining.size).toBe(0);
    expect(h.world.history.slice(start).filter(e => e.kind === "pane.close")).toHaveLength(0);
    expect(h.world.history.slice(start).filter(e => e.kind === "process.birth")).toHaveLength(0);
    expect(h.world.history.slice(start).filter(e => e.kind === "exec.call" && e.command === "herdr" && e.args[0] === "agent" && e.args[1] === "start")).toHaveLength(0);
  } finally { h.world.dispose(); }
}, 60000);

it("falls back to a stopped epoch and allocates new Worker Sessions", async () => {
  const h = await migrationWorld();
  try {
    const before = JSON.parse(fs.readFileSync(h.disk("config.json"), "utf8"));
    const sessions = new Map([...h.actors].map(([name, actor]) => [name, actor.session.getSessionId()]));
    expect((await h.tool("lead", "team_shutdown", {})).details).toMatchObject({ kind: "team_shutdown", lifecycle: "stopped", stopped_workers: ["w1", "w2", "w3"], unfinished_task_ids: ["w1", "w2", "w3"] });
    for (const name of names.slice(1)) expect(h.world.processes.actor(`${team}/${name}`)?.alive ?? false).toBe(false);
    await h.reload("lead");
    const created = await h.tool("lead", "team_create", { name: team, purpose: "Synthetic stopped-epoch migration" });
    expect(created.details.kind).toBe("team_created");
    const after = JSON.parse(fs.readFileSync(h.disk("config.json"), "utf8"));
    expect(before.epochId).toBeTruthy();
    expect(after.epochId).toBeTruthy();
    expect(after.epochId).not.toBe(before.epochId);
    for (const name of names.slice(1)) {
      const ensured = await h.tool("lead", "ensure_worker", { name, scope: `Scope ${name}` });
      expect(ensured.details).toMatchObject({ kind: "worker_ensured", effect: "created" });
      expect(h.actors.get(name)!.session.getSessionId()).not.toBe(sessions.get(name));
      expect(h.runtime(name).osBirthToken).toBeTruthy();
    }
    expect(h.actors.get("lead")!.session.getSessionId()).toBe(sessions.get("lead"));
  } finally { h.world.dispose(); }
}, 60000);
