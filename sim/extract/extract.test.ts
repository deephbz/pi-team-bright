import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ShapeRedactor } from "./shape";
import { reconstruct, type TeamInput } from "./reconstruct";
import { validateWorldTrace } from "./validate";
import { assertExternalDirectory, extractCorpus } from "./index";

const base = (): TeamInput => ({ config: { name: "private-team", createdAt: 100, members: [
  { name: "private-worker", agentId: "private-agent", membershipId: "private-membership", isActive: true },
] }, events: [], runtime: [], taskState: [], sessions: [], provenance: "a".repeat(64) });
const assistant = (id: string, timestamp: number, stopReason: string, content: unknown[] = []) =>
  ({ type: "message", id, timestamp, message: { role: "assistant", stopReason, content } });
const call = (name: string, args: unknown) => ({ type: "toolCall", name, arguments: args });

it("validates every hand-written fixture against WorldTrace and rejects malformed mutations", () => {
  const directory = path.resolve(__dirname, "../fixtures/traces");
  const files = fs.readdirSync(directory).filter(f => f.endsWith(".json"));
  expect(files.length).toBeGreaterThanOrEqual(5);
  expect(files.length).toBeLessThanOrEqual(10);
  const ids = new Set<string>();
  for (const file of files) {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    validateWorldTrace(value);
    expect(value.source).toBe("synthetic");
    expect(ids.has(value.id)).toBe(false);
    ids.add(value.id);
    expect(() => validateWorldTrace({ ...value, assumptions: ["A-unknown"] })).toThrow();
    expect(() => validateWorldTrace({ ...value, assumptions: ["S-undeclared"] })).toThrow();
    const invalidTool = (tool: string, args: unknown) => ({ ...value, steps: [{ at: 0, step: { kind: "tool.call", who: { team: "team-1", actor: "lead" }, tool, args } }] });
    expect(() => validateWorldTrace(invalidTool("team_create", { name: "team-1" }))).toThrow();
    expect(() => validateWorldTrace(invalidTool("team_sync", { view: "updates", cursor: "stale" }))).toThrow();
    expect(() => validateWorldTrace(invalidTool("task_update", { task_id: "task-1", operation_id: "op-1", expected_version: "invalid", transition: "claim" }))).toThrow();
    expect(() => validateWorldTrace({ ...value, steps: [{ at: 0, step: { kind: "pi.shutdown", who: { team: "team-1", actor: "w1" }, reason: "stopped" } }] })).toThrow();
    expect(() => validateWorldTrace({ ...value, steps: [{ at: -1, step: { kind: "os.reboot" } }] })).toThrow();
    expect(() => validateWorldTrace({ ...value, steps: [{ at: 1, step: { kind: "os.reboot" } }, { at: 0, step: { kind: "os.reboot" } }] })).toThrow();
    expect(() => validateWorldTrace({ ...value, steps: [{ at: 0, step: { kind: "os.reboot", secret: "extra" } }] })).toThrow();
    expect(() => validateWorldTrace({ ...value, steps: [{ at: 0, step: { kind: "tool.call", who: { team: "team-1", actor: "lead" }, tool: "task_read", args: { task_id: { $fromStep: 0, path: "id" } } } }] })).toThrow();
    expect(() => validateWorldTrace({ ...value, steps: [{ at: 0, step: { kind: "fault.set", fault: { source: "pi.start", mode: "slow" } } }] })).toThrow();
  }
});

it("validates literal siblings while deferring backward result-reference values", () => {
  const trace = { version: 1, id: "refs", source: "synthetic", assumptions: [], setup: { ptbVersion: "baseline", teams: [] }, steps: [
    { at: 0, step: { kind: "tool.call", who: { team: "team-1", actor: "lead" }, tool: "task_read", args: { task_ids: ["task-1"] } } },
    { at: 0, step: { kind: "tool.call", who: { team: "team-1", actor: "lead" }, tool: "task_update", args: { task_id: "task-1", operation_id: "op-1", expected_version: { $fromStep: 0, path: "task.version" }, transition: "claim" } } },
  ] };
  expect(() => validateWorldTrace(trace)).not.toThrow();
  trace.steps[1].step.args.transition = "invalid";
  expect(() => validateWorldTrace(trace)).toThrow();
});

it("uses each role's live argument schema", () => {
  const validate = (actor: string, tool: string, args: Record<string, unknown>) => validateWorldTrace({
    version: 1, id: "roles", source: "synthetic", assumptions: [], setup: { ptbVersion: "baseline", teams: [] },
    steps: [{ at: 0, step: { kind: "tool.call", who: { team: "team-1", actor }, tool, args } }],
  });
  expect(() => validate("w1", "task_read", { task_id: "task-1" })).not.toThrow();
  expect(() => validate("w1", "task_read", { task_ids: ["task-1"] })).toThrow();
  expect(() => validate("lead", "task_read", { task_id: "task-1" })).toThrow();
  expect(() => validate("lead", "task_read", { task_ids: ["task-1"] })).not.toThrow();
  expect(() => validate("w1", "alert_send", { kind: "attention", text: "Synthetic alert" })).not.toThrow();
  expect(() => validate("w1", "alert_send", { kind: "announcement", text: "Synthetic alert" })).toThrow();
  expect(() => validate("w1", "team_create", { name: "team-1", purpose: "Synthetic purpose" })).toThrow();
});

it("preserves valid public argument shapes and repeated identities", () => {
  const redactor = new ShapeRedactor();
  const samples = [
    ["lead", "team_create", { name: "private-team", purpose: "Private purpose" }],
    ["lead", "ensure_worker", { name: "private-worker", scope: "Private scope" }],
    ["w1", "task_update", { task_id: "private-task", operation_id: "private-op", expected_version: "v_abcdef0123456789", transition: "claim" }],
    ["lead", "task_read", { task_ids: ["private-task", "other-task"] }],
  ] as const;
  for (const [actor, tool, args] of samples) {
    const projected = redactor.args(args);
    expect(Object.keys(projected)).toEqual(Object.keys(args));
    for (const [key, value] of Object.entries(args)) {
      expect(typeof projected[key]).toBe(typeof value);
      if (typeof value === "string" || Array.isArray(value)) expect(projected[key]).toHaveLength(value.length);
    }
    validateWorldTrace({ version: 1, id: "shape", source: "synthetic", assumptions: [], setup: { ptbVersion: "v3.1", teams: [] },
      steps: [{ at: 0, step: { kind: "tool.call", who: { team: "team-1", actor }, tool, args: projected } }] });
  }
  expect(redactor.args({ task_id: "private-task" }).task_id).toBe(redactor.args({ needs: ["private-task"] }).needs[0]);
  expect(redactor.args({ pid: 12345 }).pid).not.toBe(redactor.args({ pid: 12346 }).pid);
  expect(redactor.args({ count: 12, force: false, metadata: null })).toEqual({ count: 12, force: false, metadata: null });
});

describe("source projection", () => {
  it("redacts nested keys, prose, paths, numeric identities and unknown tools while preserving joins", () => {
    const input = base();
    input.sessions = [
      { identity: "/private/session-lead.jsonl", actor: "team-lead", lead: true, rows: [
        assistant("entry-1", 100, "toolUse", [call("ensure_worker", { name: "private-worker", scope: "private-prose", cwd: "/private/work", pid: 987654321,
          metadata: JSON.parse('{"private-key":"private-value","__proto__":"private-prototype"}') }), call("private-tool", { text: "private-secret" })]),
        assistant("entry-2", 200, "toolUse", [call("task_graph_apply", { tasks: [{ id: "private-task", assignee: "private-worker", needs: ["private-task"] }] })]),
      ] },
      { identity: "/private/session-worker.jsonl", actor: "private-worker", lead: false, rows: [
        assistant("entry-3", 300, "toolUse", [call("task_update", { task_id: "private-task", transition: "claim", expected_version: "private-version" })]),
      ] },
    ];
    const { trace } = reconstruct(input);
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("987654321");
    expect(serialized).not.toContain("__proto__");
    const toolSteps = trace.steps.map(x => x.step).filter(s => s.kind === "tool.call");
    expect(toolSteps).toHaveLength(3);
    const task = (toolSteps[1].args.tasks as { assignee: string; id: string; needs: string[] }[])[0];
    expect(toolSteps[0].args.name).toBe(task.assignee);
    expect(task.id).toBe(toolSteps[2].args.task_id);
    expect(task.needs[0]).toBe(toolSteps[2].args.task_id);
    expect(toolSteps[2]).toMatchObject({ who: { team: toolSteps[0].who.team, actor: toolSteps[0].args.name }, args: { transition: "claim" } });
  });

  it("orders clocks, keeps aborted/error outcomes, and does not equate abort with Escape or stop with agent_end", () => {
    const input = base();
    input.sessions = [{ identity: "session-a", actor: "team-lead", lead: true, rows: [
      assistant("old", 90, "stop"), assistant("a", 400, "aborted"), assistant("b", 200, "error"),
      assistant("c", 500, "stop"), assistant("c", 500, "stop"),
      { type: "message", message: { role: "assistant", stopReason: "stop" } },
    ] }];
    input.runtime = [{ agentName: "private-worker", membershipId: "private-membership", runState: "settled", lastHeartbeatAt: 800 }];
    input.events = [{ type: "worker", phase: "stopped", at: 900 }];
    const result = reconstruct(input);
    const team = result.trace.setup.teams[0].team;
    expect(result.trace.steps.filter(x => x.step.kind === "turn.end").map(x => [x.at, x.step])).toEqual([
      [0, { kind: "turn.end", who: { team, actor: "lead" }, outcome: "error" }],
      [200, { kind: "turn.end", who: { team, actor: "lead" }, outcome: "aborted" }],
      [300, { kind: "turn.end", who: { team, actor: "lead" }, outcome: "settled" }],
    ]);
    expect(result.trace.steps.map(x => x.at)).toEqual([0, 0, 200, 300]);
    expect(result.trace.steps.some(x => ["human.escape", "pi.shutdown", "agent.settled", "os.kill"].includes(x.step.kind))).toBe(false);
    expect(result.incidents.Escape).toEqual({ observed: 0, candidate: 1 });
    expect(result.coverage).toMatchObject({ duplicateEntries: 1, untimedRows: 1 });
  });

  it("separates observed generation changes and stale bindings from speculative PID reuse", () => {
    const input = base();
    input.events = [
      { type: "worker", phase: "session_bound", worker: "private-worker", cursor: 1, generation: { membershipId: "a", pid: 1000, startedAt: 100 } },
      { type: "worker", phase: "session_bound", worker: "private-worker", cursor: 2, generation: { membershipId: "a", pid: 1000, startedAt: 100 } },
      { type: "worker", phase: "session_bound", worker: "private-worker", cursor: 3, generation: { membershipId: "b", pid: 1000, startedAt: 200 } },
      { type: "task", cursor: 3 },
    ];
    input.runtime = [{ agentName: "private-worker", membershipId: "old-membership" }];
    input.taskState = [{ events: [{ transition: "claim", actor: "private-worker" }] }];
    const result = reconstruct(input);
    expect(result.incidents.restart).toEqual({ observed: 1, candidate: 0 });
    expect(result.incidents["pid reuse"]).toEqual({ observed: 0, candidate: 1 });
    expect(result.incidents["stale binding"]).toEqual({ observed: 1, candidate: 0 });
    expect(result.incidents["cursor replay"]).toEqual({ observed: 0, candidate: 1 });
    expect(result.trace.steps).toEqual([]);
  });

  it("reads explicit lifecycle/input events and repeated cursors without emitting source identifiers", () => {
    const input = base();
    input.sessions = [{ identity: "private-session", actor: "team-lead", lead: true, rows: [
      assistant("a", 100, "toolUse", [call("team_sync", { view: "updates", cursor: "private-cursor" })]),
      { type: "human_escape", timestamp: 110 },
      assistant("b", 110, "aborted"),
      { type: "agent_end", timestamp: 110 },
      { type: "session_shutdown", timestamp: 120, reason: "reload" },
      { type: "session_start", timestamp: 130, reason: "reload" },
      { type: "pane_closed", timestamp: 140, paneId: "private-pane" },
      { type: "pane_input", timestamp: 140, paneId: "private-pane", text: "private-command /private/path" },
      { type: "compaction", timestamp: 141, summary: "private-summary" },
      { type: "branch_summary", timestamp: 142, parentId: "private-entry", summary: "private-summary" },
      { type: "session_fork", timestamp: 143, fromEntry: "private-entry", newSession: "private-new-session" },
      { type: "session_new", timestamp: 144, newSession: "private-other-session" },
      assistant("c", 150, "toolUse", [call("team_sync", { view: "updates", cursor: "private-cursor" })]),
    ] }];
    const result = reconstruct(input);
    expect(result.incidents["cursor replay"].observed).toBe(1);
    expect(result.incidents.Escape).toEqual({ observed: 1, candidate: 1 });
    expect(result.incidents["pane loss"].observed).toBe(1);
    expect(result.trace.steps.map(x => x.step.kind)).toEqual(expect.arrayContaining(["pi.shutdown", "agent.settled", "human.closePane", "human.escape", "human.typeInPane", "pi.compact", "pi.tree", "pi.fork", "pi.newSession"]));
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("keeps the creation coordinate and the distinct full-name argument lengths", () => {
    const input = base();
    input.config.name = "20260101-private-team";
    input.sessions = [{ identity: "session", actor: "team-lead", lead: true, rows: [
      assistant("old", 70, "stop"),
      assistant("create", 90, "toolUse", [call("team_create", { name: "private-team" })]),
      assistant("sync", 110, "toolUse", [call("team_sync", { team: "20260101-private-team" })]),
    ] }];
    const result = reconstruct(input);
    const calls = result.trace.steps.map(x => x.step).filter(s => s.kind === "tool.call");
    expect(calls.map(c => c.tool)).toEqual(["team_create", "team_sync"]);
    expect(calls[0].args.name).toBe(calls[1].who.team);
    expect(calls[1].args.team).toHaveLength("20260101-private-team".length);
    expect(calls[0].args.name).toHaveLength("private-team".length);
    expect(result.trace.setup.teams).toEqual([]);
    expect(result.trace.steps.map(x => x.at)).toEqual([0, 0, 20]);
  });

  it("stops unqualified lead actions when the same Session creates a different Team", () => {
    const input = base();
    input.sessions = [{ identity: "session", actor: "team-lead", lead: true, rows: [
      assistant("a", 100, "toolUse", [call("team_sync", {})]),
      assistant("b", 200, "toolUse", [call("team_create", { name: "other-team" })]),
      assistant("c", 300, "stop", [call("ensure_worker", { name: "unrelated" })]),
    ] }];
    const result = reconstruct(input);
    expect(result.trace.steps.filter(x => x.step.kind === "tool.call")).toHaveLength(1);
    expect(result.trace.steps.some(x => x.step.kind === "turn.end")).toBe(false);
  });
});

it("reads disk sources without changing bytes and writes only a validated external corpus", () => {
  const previousHome = process.env.HOME;
  const home = fs.realpathSync(process.env.PI_TEAMS_VITEST_HOME!);
  process.env.HOME = home;
  const sourceFiles = new Map<string, string>();
  const put = (file: string, value: unknown, jsonl = false) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = jsonl ? (value as unknown[]).map(x => JSON.stringify(x)).join("\n") + '\n{"partial"' : JSON.stringify(value);
    fs.writeFileSync(file, text);
    sourceFiles.set(file, text);
  };
  try {
    const team = path.join(home, ".pi/teams/synthetic-input");
    const session = path.join(home, ".pi/agent/sessions/synthetic/0_session-a.jsonl");
    put(path.join(team, "config.json"), { name: "private-team", createdAt: 100, leadSessionId: "session-a", members: [] });
    put(path.join(team, "events/team-events.jsonl"), [], true);
    put(path.join(team, "task-authority/graph-control.json"), { schema: 1, events: [] });
    put(session, [assistant("a", 100, "toolUse", [call("team_sync", { view: "snapshot" })]), assistant("b", 200, "stop")], true);
    const result = extractCorpus();
    expect(result.traces).toBe(1);
    expect(result.stats.malformed).toBe(2);
    for (const [file, bytes] of sourceFiles) expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    const output = path.join(home, ".pi/ptb-sim-corpus");
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
    for (const item of manifest.manifest) {
      const text = fs.readFileSync(path.join(output, manifest.run, `${item.id}.json`), "utf8");
      validateWorldTrace(JSON.parse(text));
      expect(text).not.toContain("private");
      expect(text).not.toContain(home);
    }
    expect(fs.readFileSync(path.join(output, "REPORT.md"), "utf8")).toContain("Zero is unobserved, not absent");
    expect(() => assertExternalDirectory(path.resolve(__dirname, "../fixtures"))).toThrow("outside repositories");
    const link = path.join(home, "corpus-link");
    fs.symlinkSync(output, link);
    expect(() => assertExternalDirectory(link)).toThrow("Unsafe corpus directory");
  } finally { process.env.HOME = previousHome; }
});
