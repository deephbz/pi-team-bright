import { createHash } from "node:crypto";
import type { WorldStep, WorldTrace } from "../trace-format";
import { validateWorldTrace } from "./validate";

type Row = Record<string, any>;
export interface SessionInput { identity: string; actor: string; lead: boolean; rows: Row[] }
export interface TeamInput {
  config: Row;
  events: Row[];
  runtime: Row[];
  taskState: Row[];
  sessions: SessionInput[];
  /** SHA-256 over the bytes read by the source adapter. */
  provenance: string;
}
export const incidentNames = ["restart", "Escape", "pid reuse", "cursor replay", "stale binding", "pane loss"] as const;
export type Incident = typeof incidentNames[number];
export interface Extraction {
  trace: WorldTrace;
  incidents: Record<Incident, { observed: number; candidate: number }>;
  coverage: { sessionRows: number; eventRows: number; runtimeRows: number; taskSnapshots: number; duplicateEntries: number; untimedRows: number };
}

const tools = new Set([
  "team_create", "team_sync", "team_shutdown", "ensure_worker", "worker_stop", "task_graph_apply",
  "task_read", "task_update", "alert_send", "task_create", "task_list", "task_link", "task_close",
  "worker_ensure", "spawn_teammate", "teammate_shutdown", "send_message", "broadcast_message", "check_teammate",
]);
const keys = new Set(("team team_name name worker worker_name agent assignee to from actor session session_id sessionFile " +
  "task task_id taskId id ref needs dependencies tasks changes nodes edges relations goal title description scope prompt text " +
  "context current_context evidence reason operation_id expected_version expected_graph_version version cursor after_cursor " +
  "view transition operation kind status model_role model thinking cwd path timeout timeout_ms limit count force cascade " +
  "mode target source failure_route retry max_attempts on_failure repair cancel resume shutdown args metadata").split(" "));
const enums: Record<string, string[]> = {
  transition: ["claim", "block", "resume", "goal_achieved", "goal_failed", "cancel"],
  operation: ["claim", "block", "resume", "goal_achieved", "goal_failed", "cancel"],
  view: ["snapshot", "updates"], kind: ["clarification", "attention", "announcement", "needs", "failure"],
  status: ["ready", "in_progress", "blocked", "done", "failed", "cancelled", "open", "closed"],
  thinking: ["off", "minimal", "low", "medium", "high", "xhigh"],
};
const numeric = new Set(["timeout", "timeout_ms", "limit", "count", "max_attempts"]);
function record(x: unknown): x is Row { return !!x && typeof x === "object" && !Array.isArray(x); }
function time(x: unknown): number | undefined {
  const n = typeof x === "number" ? x : typeof x === "string" ? Date.parse(x) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Per-Team references preserve equality without retaining a reversible identity map. */
class Opaque {
  private refs = new Map<string, string>();
  private counters = new Map<string, number>();
  bind(raw: unknown, token: string) { if (typeof raw === "string" && raw) this.refs.set(raw, token); }
  ref(raw: unknown, prefix = "ref"): string {
    const key = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "missing";
    const found = this.refs.get(key);
    if (found) return found;
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const token = `${prefix}-${n}`;
    this.refs.set(key, token);
    return token;
  }
  args(value: unknown, key = "", depth = 0): any {
    if (depth > 40) return this.ref("depth-limit", "text");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && numeric.has(key) && Number.isFinite(value)) return value;
    if (typeof value === "string" && Object.hasOwn(enums, key) && enums[key].includes(value)) return value;
    if (Array.isArray(value)) return value.map(v => this.args(v, key, depth + 1));
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      keys.has(k) ? k : this.ref(k, "key"), this.args(v, k, depth + 1),
    ]));
    const prefix = /task|^id$|^ref$|^needs$|dependencies/.test(key) ? "task"
      : /version|cursor/.test(key) ? "version" : /pane/i.test(key) ? "pane"
      : /session/i.test(key) ? "session" : /name|worker|assignee|actor|^to$|^from$/.test(key) ? "actor" : "text";
    return this.ref(value, prefix);
  }
}

/** Pure projection. Store snapshots qualify evidence; they never become model calls. */
export function reconstruct(input: TeamInput): Extraction {
  if (!/^[a-f0-9]{64}$/.test(input.provenance)) throw new Error("Invalid source digest");
  const opaque = new Opaque();
  const team = "team-1";
  opaque.bind(input.config.name, team);
  if (typeof input.config.name === "string") opaque.bind(input.config.name.replace(/^\d{8}-/, ""), team);
  opaque.bind(input.config.leadAgentId, "lead");
  opaque.bind("team-lead", "lead");
  const members = Array.isArray(input.config.members) ? input.config.members.filter(record) : [];
  for (const s of input.sessions) if (s.lead) opaque.bind(s.actor, "lead");
  for (const m of members) {
    const actor = opaque.ref(m.name, "w");
    opaque.bind(m.agentId, actor);
  }
  const incidents = Object.fromEntries(incidentNames.map(k => [k, { observed: 0, candidate: 0 }])) as Extraction["incidents"];
  const coverage = { sessionRows: 0, eventRows: input.events.length, runtimeRows: input.runtime.length,
    taskSnapshots: input.taskState.length, duplicateEntries: 0, untimedRows: 0 };
  const steps: { time: number; step: WorldStep; order: number }[] = [];
  const assumptions = new Set(["A-extraction-partial-observation", "A-session-window-from-team-config", "A-redacted-tool-arguments"]);
  const start = time(input.config.createdAt) ?? 0;
  const matchesTeam = (name: unknown) => typeof name === "string" && typeof input.config.name === "string"
    && (name === input.config.name || name === input.config.name.replace(/^\d{8}-/, ""));
  const add = (at: unknown, step: WorldStep) => {
    const t = time(at);
    if (t === undefined) { coverage.untimedRows++; return; }
    steps.push({ time: t, step, order: steps.length });
  };

  // Generation evidence can detect replacement, but cannot establish a cause of death.
  const generations = new Map<string, string>();
  const pids = new Map<number, string>();
  const seenGenerations = new Set<string>();
  const cursors = new Set<string>();
  for (const event of input.events) {
    if (typeof event.cursor === "string" || typeof event.cursor === "number") {
      const cursor = String(event.cursor);
      if (cursors.has(cursor)) incidents["cursor replay"].candidate++;
      cursors.add(cursor);
    }
    if (event.type !== "worker" || event.phase !== "session_bound" || !record(event.generation)) continue;
    const g = event.generation;
    if (!Number.isSafeInteger(g.pid) || !Number.isFinite(g.startedAt)) continue;
    const identity = JSON.stringify([event.worker, g.membershipId, g.pid, g.startedAt]);
    if (seenGenerations.has(identity)) continue;
    seenGenerations.add(identity);
    const previous = generations.get(event.worker);
    if (previous && previous !== identity) incidents.restart.observed++;
    generations.set(event.worker, identity);
    if (pids.has(g.pid) && pids.get(g.pid) !== identity) incidents["pid reuse"].candidate++;
    pids.set(g.pid, identity);
  }
  for (const runtime of input.runtime) {
    const member = members.find(m => m.name === runtime.agentName && m.isActive !== false);
    if (member && runtime.membershipId && member.membershipId && runtime.membershipId !== member.membershipId)
      incidents["stale binding"].observed++;
    // A heartbeat timestamp does not timestamp agent_end. Do not emit settled here.
  }

  const seenEntries = new Set<string>();
  for (const session of input.sessions) {
    const actor = session.lead ? "lead" : opaque.ref(session.actor, "w");
    const who = { team, actor };
    const syncCursors = new Set<string>();
    // team_create is logged before config.createdAt. Keep the nearest matching call.
    let windowStart = start;
    if (session.lead) {
      const creates = session.rows.filter(row => row.type === "message" && row.message?.role === "assistant"
        && Array.isArray(row.message.content) && row.message.content.some((block: any) => block?.type === "toolCall"
          && block.name === "team_create" && matchesTeam(block.arguments?.name)))
        .map(row => time(row.timestamp ?? row.message?.timestamp)).filter((t): t is number => t !== undefined && t <= start);
      if (creates.length) windowStart = Math.max(...creates);
      const first = session.rows.map(row => time(row.timestamp ?? row.at ?? row.message?.timestamp))
        .filter((t): t is number => t !== undefined && t >= windowStart).reduce((a, b) => Math.min(a, b), Infinity);
      if (Number.isFinite(first)) {
        add(first, { kind: "pi.start", who, session: opaque.ref(session.identity, "session"), reason: "startup" });
        assumptions.add("A-lead-start-at-first-observation");
      }
    }
    let leftTeam = false;
    for (const row of session.rows) {
      coverage.sessionRows++;
      const at = time(row.timestamp ?? row.at ?? row.message?.timestamp);
      if (at === undefined) { coverage.untimedRows++; continue; }
      if (at < windowStart) continue;
      const identity = typeof row.id === "string" ? `${actor}:${row.id}` : undefined;
      if (identity && seenEntries.has(identity)) { coverage.duplicateEntries++; continue; }
      if (identity) seenEntries.add(identity);
      const message = row.type === "message" && record(row.message) ? row.message : undefined;
      if (message?.role === "assistant") {
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (!record(block) || block.type !== "toolCall" || !tools.has(block.name)) continue;
          const args = record(block.arguments) ? block.arguments : {};
          const namedTeam = args.team_name ?? args.team ?? (block.name === "team_create" ? args.name : undefined);
          if (typeof namedTeam === "string" && input.config.name && !matchesTeam(namedTeam)) {
            if (session.lead && block.name === "team_create") leftTeam = true;
            continue;
          }
          if (leftTeam) continue;
          if (block.name === "team_sync") {
            const cursor = args.cursor ?? args.after_cursor;
            if (cursor !== undefined) {
              const key = JSON.stringify(cursor);
              if (syncCursors.has(key)) incidents["cursor replay"].observed++;
              syncCursors.add(key);
            }
          }
          add(at, { kind: "tool.call", who, tool: block.name, args: opaque.args(args) });
        }
        if (!leftTeam && ["stop", "aborted", "error"].includes(message.stopReason)) {
          const outcome = message.stopReason === "stop" ? "settled" : message.stopReason;
          add(at, { kind: "turn.end", who, outcome });
          if (outcome === "aborted") incidents.Escape.candidate++;
          assumptions.add("A-assistant-stop-is-turn-end");
        }
      }
      if (leftTeam) continue;
      if (message?.role === "toolResult" && tools.has(message.toolName)) {
        // Fixed diagnostic patterns are classification inputs only. No text leaves this function.
        const diagnostic = JSON.stringify([message.details, message.content]);
        if (/not the current binding|not a current member|fork\/stale Session|stale[_ -](?:binding|membership)/i.test(diagnostic))
          incidents["stale binding"].candidate++;
        if (/pane (?:has been closed|not found|does not exist)|target[_ -]missing/i.test(diagnostic))
          incidents["pane loss"].candidate++;
      }
      // Native event exports may contain these records. Ordinary Session JSONL usually does not.
      // Require explicit typed evidence. Do not parse prose or shell commands as human actions.
      switch (row.type) {
        case "session_shutdown":
          if (["quit", "reload", "new", "resume", "fork"].includes(row.reason))
            add(at, { kind: "pi.shutdown", who, reason: row.reason });
          break;
        case "session_start":
          if (["startup", "resume", "reload"].includes(row.reason)) {
            add(at, { kind: "pi.start", who, session: opaque.ref(session.identity, "session"), reason: row.reason });
            if (row.reason !== "startup") incidents.restart.observed++;
          }
          break;
        case "compaction":
          add(at, { kind: "pi.compact", who });
          assumptions.add("A-compaction-record-is-action");
          break;
        case "branch_summary":
          if (typeof row.parentId === "string") {
            add(at, { kind: "pi.tree", who, targetEntry: opaque.ref(row.parentId, "entry") });
            assumptions.add("A-branch-summary-parent-is-tree-target");
          }
          break;
        case "session_fork":
          if (typeof row.fromEntry === "string" && typeof row.newSession === "string")
            add(at, { kind: "pi.fork", who, fromEntry: opaque.ref(row.fromEntry, "entry"), newSession: opaque.ref(row.newSession, "session") });
          break;
        case "session_new":
          if (typeof row.newSession === "string") add(at, { kind: "pi.newSession", who, newSession: opaque.ref(row.newSession, "session") });
          break;
        case "agent_end": add(at, { kind: "agent.settled", who }); break;
        case "human_escape": add(at, { kind: "human.escape", who }); incidents.Escape.observed++; break;
        case "human_interrupt": add(at, { kind: "human.interrupt", who }); break;
        case "pane_input":
          if (typeof row.paneId === "string" && typeof row.text === "string")
            add(at, { kind: "human.typeInPane", pane: opaque.ref(row.paneId, "pane"), text: opaque.ref(row.text, "text") });
          break;
        case "pane_closed":
          if (typeof row.paneId === "string") {
            add(at, { kind: "human.closePane", pane: opaque.ref(row.paneId, "pane") });
            incidents["pane loss"].observed++;
          }
          break;
      }
    }
  }
  steps.sort((a, b) => a.time - b.time || a.order - b.order);
  const origin = steps[0]?.time ?? 0;
  const timed = steps.map(item => ({ at: item.time - origin, step: item.step }));
  const createsTeam = steps.some(item => item.step.kind === "tool.call" && item.step.tool === "team_create");
  const workers = [...new Set(input.sessions.filter(s => !s.lead).map(s => opaque.ref(s.actor, "w")))];
  if (!createsTeam) assumptions.add("A-initial-workers-from-session-bindings");
  const digest = createHash("sha256").update(input.provenance).digest("hex");
  const trace: WorldTrace = { version: 1, id: `trace-${digest.slice(0, 24)}`, source: "empirical",
    provenance: input.provenance, assumptions: [...assumptions].sort(),
    setup: { ptbVersion: "baseline", teams: createsTeam ? [] : [{ team, workers }] }, steps: timed };
  validateWorldTrace(trace);
  return { trace, incidents, coverage };
}
