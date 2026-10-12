#!/usr/bin/env node
// Actual Pi, production PTB, isolated authority, and a loopback scripted provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ScriptedScenario, toolCallResponse as call } from "../team-sync-continuity-e2e/harness.mjs";

async function run(id, execute, env = {}) {
  const s = new ScriptedScenario({ pi: {
    piCli: process.env.PI_TEAM_SYNC_TEST_PI_CLI,
    extraArgs: ["-e", fileURLToPath(new URL("./probes.ts", import.meta.url))], env,
  } });
  try {
    await s.start();
    await s.prompt(`Set up ${id}.`);
    const [created] = await s.step(call("team_create", { name: `scenario-${randomUUID().slice(0, 8)}`, purpose: "Verify native Team observation." }));
    assert.equal(created.kind, "team_created", JSON.stringify(created));
    await s.finish();
    const results = await execute(s);
    console.log(JSON.stringify({ scenario: id, status: "passed", results }));
  } finally { await s.close(); }
}

await run("S1-consecutive", async s => {
  await s.prompt("Observe twice in consecutive assistant turns.");
  const firstCall = call("team_sync", { view: "snapshot" });
  const [first] = await s.step(firstCall);
  assert.equal(first.kind, "snapshot");
  const native = s.pi.sessionEntries().find(entry => entry.message?.toolCallId === firstCall.id);
  assert(native?.message.details.observation, "Native result must persist its cursor");
  assert.match(native.message.content[0].text, /^team_sync snapshot, events \d+-\d+\./);
  const [second] = await s.step(call("team_sync", { view: "updates" }));
  assert.equal(second.kind, "caught_up");
  await s.finish();
  // Real native compaction keeps cursor evidence; a snapshot restores context.
  const compact = await s.pi.command("compact", {}, 20_000);
  assert.equal(compact.success, true, JSON.stringify(compact));
  assert(s.pi.sessionEntries().some(entry => entry.id === native.id));
  await s.prompt("Restore current Team context after compaction.");
  const [restored] = await s.step(call("team_sync", { view: "snapshot" }));
  assert.equal(restored.kind, "snapshot");
  await s.finish();
  return ["snapshot", "caught_up", "native-compaction", "snapshot"];
});

await run("S3-framework-then-model", async s => {
  await s.prompt("Add a Worker for manual synchronization.");
  const [worker] = await s.step(call("ensure_worker", { name: "fixture-worker", scope: "Provide a Worker change for synchronization." }));
  assert.equal(worker.kind, "worker_ensured", JSON.stringify(worker));
  await s.finish();
  const request = await s.prompt("/ptb sync");
  const entry = s.pi.sessionEntries().findLast(entry => entry.type === "custom_message" && entry.customType === "ptb.team-update");
  assert(entry?.details?.through >= 0, "Manual sync must persist a native Team update");
  assert.match(entry.content, /^ptb.team-update: team_sync (snapshot|updates), events \d+-\d+\./);
  assert(JSON.stringify(request.body.messages).includes(JSON.stringify(entry.content).slice(1, -1)), "Native message must reach provider context");
  assert(!request.body.messages.some(message => message.role === "tool" && String(message.tool_call_id).startsWith("framework-team-sync")));
  const [model] = await s.step(call("team_sync", { view: "updates" }));
  assert(["caught_up", "unsettled", "updates"].includes(model.kind), JSON.stringify(model));
  await s.finish();
  return ["ptb.team-update", "page-line", model.kind];
});

await run("S5-context-loss", async s => {
  await s.prompt("Observe with one persisted result removed from provider context.");
  const observedCall = call("team_sync", { view: "snapshot" });
  await s.respond(observedCall);
  assert(s.request.body.messages.some(message => message.role === "tool" && message.content === "Scenario removed observation from model context."));
  const native = s.pi.sessionEntries().find(entry => entry.message?.toolCallId === observedCall.id);
  assert(native?.message.details.observation, "Context loss must retain the native cursor");
  await s.finish("The native observation remains delivered.");
  await s.prompt("Read after the context-loss turn.");
  const [next] = await s.step(call("team_sync", { view: "updates" }));
  assert.equal(next.kind, "caught_up");
  const [snapshot] = await s.step(call("team_sync", { view: "snapshot" }));
  assert.equal(snapshot.kind, "snapshot");
  await s.finish();
  return ["native:persisted", "context:removed", "caught_up", "snapshot"];
}, { PI_SCENARIO_DROP_SYNC: "1" });

await run("S6-historical-replay", async s => {
  const response = await s.pi.command("prompt", { message: "/scenario-history" });
  assert.equal(response.success, true);
  const render = s.pi.sessionEntries().findLast(entry => entry.customType === "scenario-history-render");
  assert(render, "Historical rendering evidence must persist");
  for (const lines of [render.data.collapsed, render.data.expanded]) {
    assert(!lines.join("\n").toLowerCase().includes("projection error"));
    assert(lines.join("\n").includes("Historical observation evidence was incomplete."));
  }
  const state = await s.pi.command("get_state");
  assert.equal((await s.pi.command("switch_session", { sessionPath: state.data.sessionFile })).success, true);
  await s.prompt("Read the historical observation after Session reload.");
  const historical = s.request.body.messages.find(message => message.role === "tool" && message.tool_call_id === "historical-team-sync");
  assert.equal(historical?.content, render.data.text, "Historical bytes changed during replay");
  await s.finish();
  return ["historical:collapsed-and-expanded", "reload:unchanged"];
});
