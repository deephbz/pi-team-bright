import type { WorldTrace } from "../trace-format";

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const ref = (x: unknown) => typeof x === "string" && x.length > 0;
const oneOf = (x: unknown, values: string[]) => typeof x === "string" && values.includes(x);
const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).every(k => keys.includes(k));
const actor = (x: unknown) => object(x) && exact(x, ["team", "actor"]) && ref(x.team) && ref(x.actor);
function argumentsValid(value: unknown, index: number): boolean {
  if (Array.isArray(value)) return value.every(x => argumentsValid(x, index));
  if (!object(value)) return true;
  if ("$fromStep" in value) return exact(value, ["$fromStep", "path"]) && Number.isSafeInteger(value.$fromStep)
    && (value.$fromStep as number) >= 0 && (value.$fromStep as number) < index && typeof value.path === "string";
  return Object.values(value).every(x => argumentsValid(x, index));
}

/** Runtime boundary for JSON fixtures and extracted traces. Reject extra fields. */
export function validateWorldTrace(value: unknown): asserts value is WorldTrace {
  const fail = () => { throw new Error("Invalid WorldTrace"); };
  if (!object(value)) return fail();
  if (!exact(value, ["version", "id", "source", "provenance", "assumptions", "setup", "steps"])
    || value.version !== 1 || !ref(value.id) || !oneOf(value.source, ["synthetic", "empirical"])
    || (value.provenance !== undefined && !ref(value.provenance))
    || !Array.isArray(value.assumptions) || !value.assumptions.every(ref)
    || !object(value.setup) || !exact(value.setup, ["ptbVersion", "teams"])
    || !oneOf(value.setup.ptbVersion, ["baseline", "v3.1"]) || !Array.isArray(value.setup.teams)
    || !value.setup.teams.every(t => object(t) && exact(t, ["team", "workers"]) && ref(t.team) && Array.isArray(t.workers) && t.workers.every(ref))
    || !Array.isArray(value.steps)) return fail();
  let previous = 0;
  for (const [index, item] of value.steps.entries()) {
    if (!object(item) || !exact(item, ["at", "step"]) || !finite(item.at)
      || (item.at as number) < previous || !object(item.step)) return fail();
    previous = item.at as number;
    const s = item.step;
    let fields: string[] = [];
    let valid = false;
    switch (s.kind) {
      case "pi.start": fields = ["who", "session", "reason"]; valid = actor(s.who) && ref(s.session) && oneOf(s.reason, ["startup", "resume", "reload"]); break;
      case "tool.call": fields = ["who", "tool", "args"]; valid = actor(s.who) && ref(s.tool) && object(s.args) && argumentsValid(s.args, index); break;
      case "turn.end": fields = ["who", "outcome"]; valid = actor(s.who) && oneOf(s.outcome, ["settled", "aborted", "error"]); break;
      case "agent.settled": case "human.escape": case "human.interrupt": case "pi.compact": fields = ["who"]; valid = actor(s.who); break;
      case "pi.tree": fields = ["who", "targetEntry"]; valid = actor(s.who) && ref(s.targetEntry); break;
      case "pi.fork": fields = ["who", "fromEntry", "newSession"]; valid = actor(s.who) && ref(s.fromEntry) && ref(s.newSession); break;
      case "pi.newSession": fields = ["who", "newSession"]; valid = actor(s.who) && ref(s.newSession); break;
      case "human.closePane": fields = ["pane"]; valid = ref(s.pane); break;
      case "human.typeInPane": fields = ["pane", "text"]; valid = ref(s.pane) && typeof s.text === "string"; break;
      case "pi.shutdown": fields = ["who", "reason"]; valid = actor(s.who) && oneOf(s.reason, ["quit", "reload", "new", "resume", "fork"]); break;
      case "os.kill": fields = ["who", "signal"]; valid = actor(s.who) && oneOf(s.signal, ["SIGTERM", "SIGKILL", "SIGHUP"]); break;
      case "os.pidReuse": fields = ["dead", "newcomer"]; valid = actor(s.dead) && ref(s.newcomer); break;
      case "os.reboot": case "herdr.restart": valid = true; break;
      case "herdr.agentState": fields = ["pane", "state"]; valid = ref(s.pane) && oneOf(s.state, ["idle", "working", "blocked", "done", "unknown"]); break;
      case "fault.set": {
        fields = ["fault"];
        const modes: Record<string, string[]> = { herdr: ["unavailable", "slow", "partial_list"], "herdr.start": ["refused", "timeout"],
          "pi.start": ["hang", "exit_before_ready"], generation: ["unavailable"], bd: ["unavailable", "slow"] };
        valid = object(s.fault) && exact(s.fault, ["source", "mode"]) && typeof s.fault.source === "string"
          && Object.hasOwn(modes, s.fault.source) && oneOf(s.fault.mode, modes[s.fault.source]);
        break;
      }
      case "fault.clear": fields = ["source"]; valid = oneOf(s.source, ["herdr", "herdr.start", "pi.start", "generation", "bd"]); break;
    }
    if (!valid || !exact(s, ["kind", ...fields])) return fail();
  }
}
