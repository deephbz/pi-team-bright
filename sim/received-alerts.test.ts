import { expect, it } from "vitest";
import { parseObservationContent } from "../src/coordination/observation-content";
import { replayTrace } from "./replay";
import type { WorldTrace } from "./trace-format";

it("recovers a directly delivered Alert after compaction in the registered team_sync model result", { timeout: 30_000 }, async () => {
  const lead = { team: "team-1", actor: "lead" };
  const worker = { team: "team-1", actor: "w1" };
  const text = "Need a decision.\nKeep the Unicode compass 🧭.";
  const trace: WorldTrace = {
    version: 1, id: "received-alert-compaction", source: "synthetic", assumptions: [],
    setup: { ptbVersion: "v3.1", teams: [{ team: "team-1", workers: ["w1"] }] },
    steps: [
      { at: 0, step: { kind: "tool.call", who: worker, tool: "alert_send", args: { kind: "clarification", text, task_id: "historical-task", task_version: "v_0123456789abcdef" } } },
      { at: 1000, step: { kind: "pi.compact", who: lead } },
      { at: 1001, step: { kind: "tool.call", who: lead, tool: "team_sync", args: { view: "snapshot" } } },
    ],
  };
  const replay = await replayTrace(trace, { seed: 0 });
  const compactIndex = replay.history.findIndex(entry => entry.kind === "world.input" && entry.step.kind === "pi.compact");
  expect(replay.history.slice(0, compactIndex).some(entry => entry.kind === "pi.message" && entry.actor.actor === "lead" && JSON.stringify(entry.message).includes("Need a decision."))).toBe(true);
  expect(replay.actors.find(actor => actor.id === "team-1/lead")?.branch.some(entry => entry.type === "compaction")).toBe(true);
  const sync = replay.history.findLast(entry => entry.kind === "tool.result" && entry.name === "team_sync");
  expect(sync?.kind).toBe("tool.result");
  if (sync?.kind !== "tool.result") throw new Error("Missing registered snapshot result");
  const row = { from: "w1", kind: "clarification", task_id: "historical-task", task_version: "v_0123456789abcdef", text };
  expect(sync.result.details).toMatchObject({ kind: "snapshot", alerts: [row], alerts_omitted: 0 });
  const content = sync.result.content?.find(block => block !== null && typeof block === "object" && !Array.isArray(block) && block.type === "text");
  if (!content || typeof content !== "object" || Array.isArray(content) || typeof content.text !== "string") throw new Error("Missing model content");
  expect(parseObservationContent(content.text)).toMatchObject({ kind: "snapshot", alerts: [row], alerts_omitted: 0 });
});
