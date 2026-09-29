#!/usr/bin/env node
/**
 * Real Pi, real Team: no Pi Team Bright message reaches the leader model while
 * the leader Session compacts.
 *
 * The loopback provider holds the leader's compaction summary request. While
 * it is held, a real Worker claims its Task and sends an Alert to the lead,
 * and the operator runs `/ptb doctor`. Each produces a Pi Team Bright model
 * message: Alert delivery, automatic team_sync, and doctor context. The check
 * requires that the leader starts no agent run until compaction ends, and that
 * the held messages reach the leader model after it.
 *
 * `COMPACTION_E2E_EXPECT=bug` inverts the verdict to reproduce the defect on a
 * checkout without the gate. `PI_TEAM_SYNC_TEST_PI_CLI` selects the Pi CLI.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE,
  createSandbox,
  LocalProviderFixture,
  PiRpcProcess,
  PrivateTmuxCarrier,
  textResponse,
  toolCallResponse,
} from "../team-sync-continuity-e2e/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC_E2E = path.join(HERE, "../team-sync-continuity-e2e");
const PI_CLI = process.env.PI_TEAM_SYNC_TEST_PI_CLI || path.join(PACKAGE, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
assert(fs.existsSync(PI_CLI), `Pi CLI does not exist: ${PI_CLI}`);
const PI_VERSION = execFileSync(process.execPath, [PI_CLI, "--version"], { encoding: "utf8" }).trim();
const PI_BIN_DIR = path.resolve(path.dirname(PI_CLI), "../../../.bin");
const EXPECT_BUG = process.env.COMPACTION_E2E_EXPECT === "bug";
const MAX_MS = 30_000;
const HOLD_MS = 3_000;
const ALERT_TEXT = "COMPACTION-PROBE-ALERT";
const TEAM = `compaction-${Math.random().toString(16).slice(2, 10)}`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastSequence = (provider) => provider.requests.at(-1)?.sequence ?? 0;
const isSummary = (item) => JSON.stringify(item.body.messages?.[0] ?? "").includes("context summarization assistant");
// Leader agent-run requests; compaction summary requests are excluded.
const leaderRequests = (provider, after) => provider.requests.filter((item) => item.sequence > after && item.body.model === "scripted" && !isSummary(item));
const mentions = (request, text) => JSON.stringify(request.body.messages).includes(text);

async function waitFor(predicate, label, timeoutMs = MAX_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const box = createSandbox();
const provider = await new LocalProviderFixture().start();
let tmux;
let pi;
try {
  fs.writeFileSync(box.path("agent", "settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 1 },
    pi_team_bright: {
      model_roles: { fixture: { model: "fixture/worker-scripted", thinking: "off", use: "Local verification Worker" } },
      default_model_role: "fixture",
      team: { wait_seconds: 0.2, auto_sync_enabled: true, auto_sync_delay_seconds: 0.2, auto_sync_update_threshold: 1 },
    },
  }));
  const shared = {
    PATH: `${PI_BIN_DIR}${path.delimiter}${process.env.PATH}`,
    PI_TEAM_BRIGHT_SHIPPED_EXTENSION: path.join(SYNC_E2E, "worker-extension.ts"),
    PI_TEAMS_MESSAGE_POLL_MS: "200",
    PI_TEAMS_TASK_POLL_MS: "200",
  };
  tmux = new PrivateTmuxCarrier(box).start({
    HOME: box.path("home"), USERPROFILE: box.path("home"), PI_CODING_AGENT_DIR: box.path("agent"),
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...shared,
  });
  pi = await new PiRpcProcess(box, provider, { piCli: PI_CLI, env: { ...tmux.childEnvironment(), ...shared } }).start();

  async function leaderTool(name, args) {
    const after = lastSequence(provider);
    const index = pi.records.length;
    assert.equal((await pi.command("prompt", { message: `Execute ${name} for this isolated verification round.` })).success, true);
    const request = await provider.requestMatching((item) => item.body.model === "scripted", after, MAX_MS);
    provider.answer(request, toolCallResponse(name, args));
    const resultRequest = await provider.requestMatching((item) => item.body.model === "scripted", request.sequence, MAX_MS);
    const result = JSON.parse(resultRequest.body.messages.at(-1).content);
    provider.answer(resultRequest, textResponse(`Observed ${name}.`));
    await pi.waitForNew((event) => event.type === "agent_settled", index, MAX_MS);
    return result;
  }

  async function workerTurn(request, name, args) {
    provider.answer(request, toolCallResponse(name, args));
    const resultRequest = await provider.requestMatching((item) => item.body.model === "worker-scripted", request.sequence, MAX_MS);
    const result = JSON.parse(resultRequest.body.messages.at(-1).content);
    provider.answer(resultRequest, textResponse(`Worker observed ${name}.`));
    return { result, resultRequest };
  }

  function promptWorker(message) {
    const panes = tmux.command("list-panes", "-t", tmux.name, "-F", "#{pane_id}").trim().split("\n");
    const workerPane = panes.find((pane) => pane !== tmux.leaderPane);
    assert(workerPane, "Private Worker pane is missing");
    tmux.command("send-keys", "-t", workerPane, "-l", message);
    tmux.command("send-keys", "-t", workerPane, "Enter");
  }

  // 1. A real Team with one real Worker and one assigned Task.
  assert.equal((await leaderTool("team_create", { name: TEAM, purpose: "Verify delivery around compaction." })).kind, "team_created");
  assert.equal((await leaderTool("ensure_worker", { name: "fixture-worker", scope: "Perform fixture checks." })).kind, "worker_ensured");
  assert.equal((await leaderTool("team_sync", { view: "snapshot" })).kind, "snapshot");
  const applied = await leaderTool("task_graph_apply", {
    operation_id: "compaction-graph",
    tasks: [{ key: "work", title: "Verify fixture", goal: "Report a fixture check.", assignee: "fixture-worker" }],
  });
  assert.equal(applied.kind, "task_graph_applied");
  const task = applied.tasks_by_key.work;
  const workerTask = await provider.requestMatching((item) => item.body.model === "worker-scripted" && mentions(item, task.id), 0, MAX_MS);
  assert.equal((await leaderTool("team_sync", { view: "updates" })).kind, "updates");

  // 2. Manual compaction. The provider holds the summary request.
  const beforeCompact = lastSequence(provider);
  const compactIndex = pi.records.length;
  let compactResponse;
  pi.command("compact", {}, 4 * MAX_MS).then((response) => { compactResponse = response; }, (error) => { compactResponse = { success: false, error: String(error) }; });
  const summary = await provider.requestMatching((item) => item.body.model === "scripted" && isSummary(item), beforeCompact, MAX_MS);
  await pi.waitForNew((event) => event.type === "compaction_start", compactIndex, MAX_MS);

  // 3. While compaction runs: Worker claim, Worker Alert to the lead, and /ptb doctor.
  const step = (label) => console.error(`[compaction-e2e] ${label}`);
  step("compaction held");
  const claim = await workerTurn(workerTask, "task_update", { task_id: task.id, operation_id: "compaction-claim", expected_version: task.version, transition: "claim" });
  assert.equal((claim.result.outcomes?.[0] ?? claim.result).kind, "updated");
  step("worker claimed");
  promptWorker("Send one attention Alert to the lead.");
  const alertPrompt = await provider.requestMatching((item) => item.body.model === "worker-scripted", claim.resultRequest.sequence, MAX_MS);
  const alert = await workerTurn(alertPrompt, "alert_send", { to: "team-lead", kind: "attention", text: ALERT_TEXT });
  assert.equal(alert.result.kind, "alert_sent", `Worker alert_send failed: ${JSON.stringify(alert.result)}`);
  step("worker alert sent");
  // The unfixed control may be mid-run here; do not block on the RPC response.
  void pi.command("prompt", { message: "/ptb doctor" }).catch(() => undefined);
  await delay(HOLD_MS);

  const duringRecords = pi.records.slice(compactIndex);
  const startedDuring = duringRecords.filter((event) => event.type === "agent_start").length;
  const leakedRequests = leaderRequests(provider, beforeCompact);
  const leaked = startedDuring > 0 || leakedRequests.length > 0;
  const observation = {
    piVersion: PI_VERSION,
    agentStartsDuringCompaction: startedDuring,
    leaderRequestsDuringCompaction: leakedRequests.length,
    alertInLeakedRequest: leakedRequests.some((item) => mentions(item, ALERT_TEXT)),
  };

  if (EXPECT_BUG) {
    assert(leaked, `Expected the unfixed checkout to deliver during compaction: ${JSON.stringify(observation)}`);
    console.log(JSON.stringify({ verdict: "bug_reproduced", ...observation }, null, 2));
  } else {
    assert(!leaked, `Pi Team Bright delivered during compaction: ${JSON.stringify(observation)}`);

    // 4. Compaction ends; the held messages reach the leader model afterward.
    // Pi may request a history summary and a turn-prefix summary.
    while (!compactResponse) {
      for (const item of provider.pending.filter(isSummary)) provider.answer(item, textResponse("Summary of the fixture Session."));
      await delay(10);
    }
    assert.equal(compactResponse.success, true, `Compaction failed: ${JSON.stringify(compactResponse)}`);
    const endIndex = pi.records.findIndex((event, index) => index >= compactIndex && event.type === "compaction_end");
    assert(endIndex >= 0, "compaction_end was not observed");
    assert.equal(pi.records.slice(compactIndex, endIndex).filter((event) => event.type === "agent_start").length, 0);
    const seen = { alert: false, doctor: false, teamSync: false };
    let after = beforeCompact;
    const deadline = Date.now() + MAX_MS;
    while (!(seen.alert && seen.doctor && seen.teamSync) && Date.now() < deadline) {
      const next = await provider.requestMatching((item) => item.body.model === "scripted" && !isSummary(item), after, deadline - Date.now());
      const messages = JSON.stringify(next.body.messages);
      seen.alert ||= messages.includes(ALERT_TEXT);
      seen.doctor ||= messages.includes("Pi Team Bright doctor") || messages.includes("team-doctor");
      seen.teamSync ||= next.body.messages.some((message) => message.role === "tool" && String(message.tool_call_id ?? "").startsWith("framework-team-sync-"));
      provider.answer(next, textResponse("Observed held delivery."));
      after = next.sequence;
    }
    assert(seen.alert, "The held Alert never reached the leader model after compaction");
    assert(seen.doctor, "The held doctor context never reached the leader model after compaction");
    assert(seen.teamSync, "The automatic team_sync never reached the leader model after compaction");
    const entries = pi.sessionEntries();
    const compactionAt = entries.findIndex((entry) => entry.type === "compaction");
    const alertAt = entries.findIndex((entry) => JSON.stringify(entry).includes(ALERT_TEXT) && entry.type === "custom_message");
    assert(compactionAt >= 0 && alertAt > compactionAt, `Alert entry ${alertAt} precedes compaction entry ${compactionAt}`);
    console.log(JSON.stringify({ verdict: "held_until_compaction_end", ...observation, afterCompaction: seen }, null, 2));
  }
} catch (error) {
  if (pi) console.error(`stderr tail: ${pi.stderr.slice(-2000)}`);
  throw error;
} finally {
  await pi?.close();
  tmux?.close();
  await provider.close();
  if (process.env.PI_TEAM_SYNC_TEST_RETAIN === "1") console.error(`Retained isolated fixture: ${box.root}`);
  else box.cleanup();
}
