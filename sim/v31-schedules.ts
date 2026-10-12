import type { ActorRef, WorldStep, WorldTrace } from "./trace-format";

export const families = ["pid-reuse", "herdr-loss", "reload-storm", "compaction", "contended-reservation", "source-ttl", "delayed-source", "append-ambiguity", "human-stop", "crash-before-record"] as const;
export interface Sample { family: number; seed: number; gap: number; repeats: number }
const lead: ActorRef = { team: "team-1", actor: "lead" };
const worker: ActorRef = { team: "team-1", actor: "w1" };

/** World inputs target real tools; no PTB state is authored or consulted. */
export function generatedTrace(sample: Sample, id: string): WorldTrace {
  const steps: WorldTrace["steps"] = [];
  const add = (at: number, step: WorldStep) => steps.push({ at, step });
  const ensure = (at: number) => add(at, { kind: "tool.call", who: lead, tool: "ensure_worker", args: { name: "w1", scope: "Synthetic campaign worker" } });
  const sync = (at: number) => add(at, { kind: "tool.call", who: lead, tool: "team_sync", args: { view: "updates" } });
  add(0, { kind: "pi.start", who: lead, session: "session-1", reason: "startup" });
  add(0, { kind: "tool.call", who: lead, tool: "team_create", args: { name: "team-1", purpose: "Synthetic v3.1 campaign" } });
  const family = families[sample.family]!;
  if (["herdr-loss", "contended-reservation", "crash-before-record"].includes(family)) add(0, { kind: "fault.set", fault: { source: "pi.start", mode: "hang" } });
  if (["herdr-loss", "contended-reservation", "crash-before-record"].includes(family)) add(0, { kind: "fault.set", fault: { source: "herdr", mode: "slow", delayMs: 200 } });
  if (family === "pid-reuse") for (let n = 1; n < sample.repeats; n++) add(0, { kind: "tool.call", who: lead, tool: "ensure_worker", args: { name: `extra-${n}`, scope: "Vary process birth order" } });
  ensure(0);
  const at = 300 + sample.gap;
  switch (family) {
    case "pid-reuse":
      add(at, { kind: "os.kill", who: worker, signal: "SIGKILL" });
      add(at, { kind: "os.pidReuse", dead: worker, newcomer: `outsider-${sample.repeats}` });
      ensure(at + 1); break;
    case "herdr-loss":
      add(1, { kind: "fault.set", fault: { source: "herdr", mode: "unavailable" } });
      ensure(at);
      add(12000, { kind: "fault.clear", source: "herdr" });
      add(12000, { kind: "fault.clear", source: "pi.start" }); break;
    case "reload-storm":
      for (let n = 0; n < sample.repeats; n++) {
        add(at + n * 200, { kind: "pi.shutdown", who: worker, reason: "reload" });
        add(at + n * 200 + 100, { kind: "pi.start", who: worker, reason: "reload", session: "session-2" });
      } break;
    case "compaction":
      add(at, { kind: "os.kill", who: worker, signal: "SIGKILL" });
      add(1000, { kind: "agent.settled", who: lead });
      add(30000, { kind: "agent.settled", who: lead });
      add(35000, { kind: "pi.compact", who: lead }); break;
    case "contended-reservation":
      for (let n = 0; n < sample.repeats; n++) ensure(1 + n);
      add(12000, { kind: "fault.clear", source: "pi.start" }); break;
    case "source-ttl":
      add(at, { kind: "fault.set", fault: { source: "generation", mode: "slow", delayMs: 7000 + sample.gap } });
      add(at, { kind: "fault.set", fault: { source: "herdr", mode: "slow", delayMs: 7000 + sample.gap } });
      sync(10000); add(15000, { kind: "fault.clear", source: "generation" });
      add(15000, { kind: "fault.clear", source: "herdr" }); break;
    case "delayed-source":
      add(at, { kind: "fault.set", fault: { source: "generation", mode: "slow", delayMs: 500 + sample.gap } });
      add(at, { kind: "fault.set", fault: { source: "herdr", mode: "slow", delayMs: 1000 + sample.gap } });
      sync(at + 1);
      add(at + 101, { kind: "os.kill", who: worker, signal: "SIGKILL" });
      add(at + 102, { kind: "os.pidReuse", dead: worker, newcomer: `outsider-${sample.repeats}` });
      add(15000, { kind: "fault.clear", source: "generation" });
      add(15000, { kind: "fault.clear", source: "herdr" }); break;
    case "append-ambiguity":
      add(at, { kind: "fault.set", fault: { source: "journal", mode: "commit_then_error" } });
      add(at + 1, { kind: "os.kill", who: worker, signal: "SIGKILL" });
      sync(at + 2);
      add(15000, { kind: "fault.clear", source: "journal" }); break;
    case "human-stop":
      add(at, { kind: "human.closePane", pane: "pane-1" }); break;
    case "crash-before-record":
      add(at, { kind: "human.closePane", pane: "pane-1" });
      add(12000, { kind: "fault.clear", source: "pi.start" }); break;
  }
  sync(40000);
  return { version: 1, id, source: "synthetic", assumptions: ["S-first-worker-pane-is-pane-1"], setup: { ptbVersion: "v3.1", teams: [] }, steps };
}

export function scaleTrace(teams: number, workers: number, firstTeam = 1): WorldTrace {
  const steps: WorldTrace["steps"] = [];
  for (let i = firstTeam; i < firstTeam + teams; i++) {
    const team = `team-${i}`; const who = { team, actor: "lead" };
    steps.push({ at: 0, step: { kind: "pi.start", who, session: `session-${i}`, reason: "startup" } },
      { at: 0, step: { kind: "tool.call", who, tool: "team_create", args: { name: team, purpose: "Synthetic scale campaign" } } });
    for (let j = 1; j <= workers; j++) steps.push({ at: 0, step: { kind: "tool.call", who, tool: "ensure_worker", args: { name: `w${j}`, scope: `Synthetic worker ${j}` } } });
  }
  for (let i = firstTeam; i < firstTeam + teams; i++) steps.push({ at: 20000, step: { kind: "tool.call", who: { team: `team-${i}`, actor: "lead" }, tool: "team_sync", args: { view: "updates" } } });
  return { version: 1, id: `v31-scale-${firstTeam}-${teams}x${workers}`, source: "synthetic", assumptions: [], setup: { ptbVersion: "v3.1", teams: [] }, steps };
}
