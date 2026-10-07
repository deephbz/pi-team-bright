#!/usr/bin/env node
// Exercise presentation timing through the real Pi loop. All providers and carriers are isolated.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ScriptedScenario, toolCallResponse as call } from "../team-sync-continuity-e2e/harness.mjs";

const expectBug = process.env.EXPECT === "bug";
assert([undefined, "bug"].includes(process.env.EXPECT), "Use EXPECT=bug or leave EXPECT unset");

async function run(id, execute, env = {}) {
  const scenario = new ScriptedScenario({ pi: {
    piCli: process.env.PI_TEAM_SYNC_TEST_PI_CLI,
    ...(id === "S2-parallel" ? { extension: fileURLToPath(new URL("./parallel-extension.ts", import.meta.url)) } : {}),
    extraArgs: ["-e", fileURLToPath(new URL("./probes.ts", import.meta.url))], env,
  } });
  try {
    await scenario.start();
    await scenario.prompt(`Set up ${id}.`);
    const [created] = await scenario.step(call("team_create", { name: `scenario-${randomUUID().slice(0, 8)}`, purpose: "Verify scripted synchronization turns." }));
    assert.equal(created.kind, "team_created", JSON.stringify(created));
    await scenario.finish();
    const results = await execute(scenario);
    console.log(JSON.stringify({ scenario: id, expect: expectBug ? "bug" : "contract", status: "passed", results }));
  } finally {
    await scenario.close();
  }
}

await run("S1-consecutive", async (s) => {
  await s.prompt("Observe twice in consecutive assistant turns.");
  const [first] = await s.step(call("team_sync", { view: "snapshot" }));
  assert.equal(first.kind, "snapshot");
  const [second] = await s.step(call("team_sync", { view: "updates" }));
  assert.equal(second.kind, expectBug ? "indeterminate" : "caught_up");
  await s.finish();
  return [first.kind, second.kind];
});

await run("S2-parallel", async (s) => {
  await s.prompt("Observe twice in one assistant message.");
  const first = call("team_sync", { view: "snapshot" });
  const second = call("team_sync", { view: "snapshot" });
  const afterIndex = s.pi.records.length;
  const results = await s.step(first, second);
  const events = s.pi.records.slice(afterIndex);
  assert(events.findIndex((e) => e.type === "tool_execution_start" && e.toolCallId === second.id)
    < events.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === first.id), "Pi did not execute parallel calls");
  assert.equal(results.filter((result) => result.kind === "snapshot").length, 1);
  if (expectBug) assert.equal(results.filter((result) => result.kind === "indeterminate").length, 1);
  else {
    const refused = results.find((result) => result.kind === "refused");
    assert(refused, "Parallel duplicate must be refused");
    assert.equal(refused.reason, "observation_in_progress");
    assert.equal(refused.state_changed, false);
    assert.equal(refused.observation_advanced, false);
    assert(refused.message.length > 0);
  }
  await s.finish();
  return results;
});

await run("S3-framework-then-model", async (s) => {
  await s.prompt("Add an idle Worker for manual synchronization.");
  const [worker] = await s.step(call("ensure_worker", { name: "fixture-worker", scope: "Provide a Worker change for framework synchronization." }));
  assert.equal(worker.kind, "worker_ensured", JSON.stringify(worker));
  await s.finish();
  const framework = await s.prompt("/teamsync");
  const entries = s.pi.sessionEntries();
  const record = entries.findLast((entry) => entry.type === "custom" && entry.data?.source === "command" && ["snapshot", "updates"].includes(entry.data?.result?.kind));
  assert(record, "Manual sync must persist a framework observation");
  assert(framework.body.messages.some((message) => message.role === "tool" && ["snapshot", "updates"].includes(JSON.parse(message.content).kind)), "Framework result must reach provider payload");
  const [model] = await s.step(call("team_sync", { view: "updates" }));
  if (expectBug) assert.equal(model.kind, "indeterminate");
  else assert(["caught_up", "unsettled", "updates"].includes(model.kind), JSON.stringify(model));
  await s.finish();
  return [`framework:${record.data.result.kind}`, model.kind];
});

await run("S4-sequential", async (s) => {
  await s.prompt("Run duplicate observations sequentially.");
  const first = call("team_sync", { view: "snapshot" });
  const second = call("team_sync", { view: "snapshot" });
  const afterIndex = s.pi.records.length;
  const results = await s.step(first, second, call("scenario_sequential", {}));
  const events = s.pi.records.slice(afterIndex);
  assert(events.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === first.id)
    < events.findIndex((e) => e.type === "tool_execution_start" && e.toolCallId === second.id), "Pi did not execute sequentially");
  assert.equal(results[0].kind, "snapshot");
  assert.equal(results[1].kind, expectBug ? "indeterminate" : "refused");
  if (!expectBug) assert.equal(results[1].reason, "observation_in_progress");
  await s.finish();
  return results.map((result) => result.kind);
});

await run("S5-absent-proof", async (s) => {
  await s.prompt("Observe with one staged result removed from provider context.");
  await s.respond(call("team_sync", { view: "snapshot" }));
  assert(s.request.body.messages.some((message) => message.role === "tool" && message.content === "Scenario removed observation before provider proof."));
  await s.finish("Complete the turn without consuming the removed observation.");
  await s.prompt("Observe in a later run after the proof-less turn settled.");
  const [next] = await s.step(call("team_sync", { view: "snapshot" }));
  assert.equal(next.kind, expectBug ? "indeterminate" : "snapshot");
  await s.finish();
  return ["proof:absent", next.kind];
}, { PI_SCENARIO_DROP_SYNC: "1" });

await run("S6-historical-replay", async (s) => {
  const response = await s.pi.command("prompt", { message: "/scenario-history" });
  assert.equal(response.success, true);
  const render = s.pi.sessionEntries().findLast((entry) => entry.customType === "scenario-history-render");
  assert(render, "Historical rendering evidence must persist");
  for (const lines of [render.data.collapsed, render.data.expanded]) {
    assert(!lines.join("\n").toLowerCase().includes("projection error"), JSON.stringify(lines));
    assert(lines.join("\n").includes("Historical observation evidence was incomplete."));
  }
  const state = await s.pi.command("get_state");
  const switched = await s.pi.command("switch_session", { sessionPath: state.data.sessionFile });
  assert.equal(switched.success, true);
  await s.prompt("Read the historical observation after Session reload.");
  const historical = s.request.body.messages.find((message) => message.role === "tool" && message.tool_call_id === "historical-team-sync");
  assert.equal(historical?.content, render.data.text, "Historical bytes changed during replay");
  await s.finish();
  return ["indeterminate:rendered", "indeterminate:replayed-unchanged"];
});
