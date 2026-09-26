#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  PACKAGE,
  createSandbox,
  LocalProviderFixture,
  PiRpcProcess,
  PrivateTmuxCarrier,
  textResponse,
  toolCallResponse,
} from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_CLI = process.env.PI_TEAM_SYNC_TEST_PI_CLI || path.join(PACKAGE, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
assert(fs.existsSync(PI_CLI), `Pi CLI does not exist: ${PI_CLI}`);
const PI_VERSION = execFileSync(process.execPath, [PI_CLI, "--version"], { encoding: "utf8" }).trim();
const PI_BIN_DIR = path.resolve(path.dirname(PI_CLI), "../../../.bin");
const MAX_MS = 30_000;
const execFileAsync = promisify(execFile);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assertNoNewRequest(provider, afterSequence, model) {
  assert.equal(provider.requests.filter((request) => request.sequence > afterSequence && request.body.model === model).length, 0);
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function latestSequence(provider) { return provider.requests.at(-1)?.sequence ?? 0; }

class Journey {
  constructor(settings) {
    this.settings = settings;
    this.box = createSandbox();
    this.teamName = `fixture-${Math.random().toString(16).slice(2, 10)}`;
  }

  async start() {
    this.provider = await new LocalProviderFixture().start();
    fs.writeFileSync(this.box.path("agent", "settings.json"), JSON.stringify({
      pi_team_bright: {
        model_roles: { fixture: { model: "fixture/worker-scripted", thinking: "off", use: "Local verification Worker" } },
        default_model_role: "fixture",
        team: this.settings,
      },
    }));
    this.tmux = new PrivateTmuxCarrier(this.box).start({
      HOME: this.box.path("home"), USERPROFILE: this.box.path("home"),
      PI_CODING_AGENT_DIR: this.box.path("agent"),
      PI_TEAM_BRIGHT_SHIPPED_EXTENSION: path.join(HERE, "worker-extension.ts"),
      PI_TEAM_SYNC_WORKER_BOOT_CAPTURE: this.box.path("worker-boot.jsonl"),
      PATH: `${PI_BIN_DIR}${path.delimiter}${process.env.PATH}`, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    });
    this.pi = await new PiRpcProcess(this.box, this.provider, {
      piCli: PI_CLI,
      env: { ...this.tmux.childEnvironment(), PATH: `${PI_BIN_DIR}${path.delimiter}${process.env.PATH}`, PI_TEAM_BRIGHT_SHIPPED_EXTENSION: path.join(HERE, "worker-extension.ts"), PI_TEAM_SYNC_WORKER_BOOT_CAPTURE: this.box.path("worker-boot.jsonl") },
    }).start();
    return this;
  }

  async close() {
    await this.pi?.close();
    this.tmux?.close();
    await this.provider?.close();
    if (process.env.PI_TEAM_SYNC_TEST_RETAIN === "1") console.error(`Retained isolated fixture: ${this.box.root}`);
    else this.box.cleanup();
  }

  async leaderTool(name, args, afterSequence = 0) {
    const afterIndex = this.pi.records.length;
    const accepted = await this.pi.command("prompt", { message: `Execute ${name} for this isolated verification round.` });
    assert.equal(accepted.success, true);
    const request = await this.provider.requestMatching((item) => item.body.model === "scripted", afterSequence, MAX_MS);
    assert(request.body.tools?.some((tool) => tool.function?.name === name), `Leader provider request does not advertise ${name}`);
    this.provider.answer(request, toolCallResponse(name, args));
    const resultRequest = await this.provider.requestMatching((item) => item.body.model === "scripted", request.sequence, MAX_MS);
    const resultMessage = resultRequest.body.messages.at(-1);
    assert.equal(resultMessage?.role, "tool", `Expected real ${name} tool result in provider context`);
    const result = JSON.parse(resultMessage.content);
    this.provider.answer(resultRequest, textResponse(`Observed ${name}.`));
    await this.pi.waitForNew((event) => event.type === "agent_settled", afterIndex, MAX_MS);
    return { result, request, resultRequest };
  }

  async establishTeam() {
    let cursor = 0;
    let outcome = await this.leaderTool("team_create", { name: this.teamName, purpose: "Verify continuous Team synchronization." }, cursor);
    assert.equal(outcome.result.kind, "team_created");
    cursor = outcome.resultRequest.sequence;
    outcome = await this.leaderTool("ensure_worker", { name: "fixture-worker", scope: "Perform independent fixture Task checks." }, cursor);
    assert.equal(outcome.result.kind, "worker_ensured");
    assert(["starting", "connected"].includes(outcome.result.worker.carrier), "ensure_worker did not launch a Worker");
    cursor = outcome.resultRequest.sequence;
    outcome = await this.leaderTool("team_sync", { view: "snapshot" }, cursor);
    assert.equal(outcome.result.kind, "snapshot");
    return outcome.resultRequest.sequence;
  }

  async assignTask(afterSequence, twoTasks = false) {
    const outcome = await this.leaderTool("task_graph_apply", {
      operation_id: "fixture-task-graph",
      tasks: [
        { key: "work", title: "Verify fixture", goal: "Report an independent fixture check.", assignee: "fixture-worker" },
        ...(twoTasks ? [{ key: "second", title: "Review fixture", goal: "Report a second independent fixture check.", assignee: "fixture-worker" }] : []),
      ],
    }, afterSequence);
    assert.equal(outcome.result.kind, "task_graph_applied");
    const task = outcome.result.tasks_by_key.work;
    assert.equal(task.status, "ready");
    const workerRequest = await this.provider.requestMatching((item) => item.body.model === "worker-scripted", 0, MAX_MS);
    assert(workerRequest.body.messages.some((message) => JSON.stringify(message).includes(task.id)), "Worker did not receive its Task through Pi");
    const runtimeFile = this.box.path("home", ".pi", "teams", this.teamName, "runtime", "fixture-worker.json");
    const bootFile = this.box.path("worker-boot.jsonl");
    const boot = await this.waitFor(() => {
      if (!fs.existsSync(runtimeFile) || !fs.existsSync(bootFile)) return undefined;
      const runtime = readJson(runtimeFile);
      const boots = fs.readFileSync(bootFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return boots.findLast((item) => item.pid === runtime.pid && item.worker === "fixture-worker");
    }, MAX_MS, "Worker's real Pi session_start");
    assert.equal(fs.realpathSync(boot.argv[1]), fs.realpathSync(PI_CLI), `Worker process used another Pi CLI: ${boot.argv[1]}`);
    this.workerVersion = PI_VERSION;
    return { task, secondTask: outcome.result.tasks_by_key.second, workerRequest, leaderSequence: outcome.resultRequest.sequence };
  }

  promptWorker(message) {
    const panes = this.tmux.command("list-panes", "-t", this.tmux.name, "-F", "#{pane_id}").trim().split("\n");
    const workerPane = panes.find((pane) => pane !== this.tmux.leaderPane);
    assert(workerPane, "Private Worker pane is missing");
    this.tmux.command("send-keys", "-t", workerPane, "-l", message);
    this.tmux.command("send-keys", "-t", workerPane, "Enter");
  }

  async workerUpdate(request, task, change, operationId) {
    this.provider.answer(request, toolCallResponse("task_update", {
      task_id: task.id, operation_id: operationId, expected_version: task.version, ...change,
    }));
    const resultRequest = await this.provider.requestMatching((item) => item.body.model === "worker-scripted", request.sequence, MAX_MS);
    const resultMessage = resultRequest.body.messages.at(-1);
    assert.equal(resultMessage?.role, "tool");
    const result = JSON.parse(resultMessage.content);
    const outcome = result.outcomes?.[0] ?? result;
    assert.equal(outcome.kind, "updated", `Worker task_update failed: ${resultMessage.content}`);
    this.provider.answer(resultRequest, textResponse("Task state recorded."));
    const runtime = this.box.path("home", ".pi", "teams", this.teamName, "runtime", "fixture-worker.json");
    await this.waitFor(() => fs.existsSync(runtime) && readJson(runtime).runState === "settled", MAX_MS, "Worker settled");
    return { task: outcome.task, resultRequest };
  }

  async waitFor(predicate, timeoutMs, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await delay(10);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  hiddenObservation() {
    const root = this.box.path("home", ".pi", "teams", this.teamName, "hidden-observations");
    if (!fs.existsSync(root)) return undefined;
    const epochs = fs.readdirSync(root);
    assert.equal(epochs.length, 1);
    const files = fs.readdirSync(path.join(root, epochs[0])).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1);
    return readJson(path.join(root, epochs[0], files[0]));
  }
}

async function activeWaitIdleAndDelayRound() {
  const journey = new Journey({ wait_seconds: 0.2, auto_sync_enabled: true, auto_sync_delay_seconds: 0.4, auto_sync_update_threshold: 1000 });
  try {
    await journey.start();
    let leaderSequence = await journey.establishTeam();
    assert(journey.hiddenObservation()?.acknowledgedEntryId, "Snapshot did not establish hidden baseline");
    await delay(850);
    assertNoNewRequest(journey.provider, leaderSequence, "scripted");
    const assigned = await journey.assignTask(leaderSequence);
    leaderSequence = assigned.leaderSequence;
    // Consume the leader-authored Task graph event while the Worker remains active.
    const graphUpdate = await journey.leaderTool("team_sync", { view: "updates" }, leaderSequence);
    assert.equal(graphUpdate.result.kind, "updates");
    leaderSequence = graphUpdate.resultRequest.sequence;

    const beforeWaitRecords = journey.pi.records.length;
    await journey.pi.command("prompt", { message: "Observe Team updates while the Worker is active." });
    const waitRequest = await journey.provider.requestMatching((item) => item.body.model === "scripted", leaderSequence, MAX_MS);
    journey.provider.answer(waitRequest, toolCallResponse("team_sync", { view: "updates" }));
    await delay(650);
    assertNoNewRequest(journey.provider, waitRequest.sequence, "scripted");
    assert.equal(journey.pi.records.slice(beforeWaitRecords).filter((event) => event.type === "tool_execution_end" && event.toolName === "team_sync").length, 0,
      "Active Worker wait ended at the former short timeout");
    const claimed = await journey.workerUpdate(assigned.workerRequest, assigned.task, { transition: "claim" }, "fixture-claim");
    const observed = await journey.provider.requestMatching((item) => item.body.model === "scripted", waitRequest.sequence, MAX_MS);
    assert.equal(JSON.parse(observed.body.messages.at(-1).content).kind, "updates");
    journey.provider.answer(observed, textResponse("Worker claim observed."));
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeWaitRecords, MAX_MS);
    const nativeEntry = journey.pi.sessionEntries().findLast((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "team_sync");
    assert(nativeEntry, "Native team_sync toolResult was not persisted");
    await journey.waitFor(() => journey.hiddenObservation()?.acknowledgedEntryId === nativeEntry.id, MAX_MS, "native sync acknowledgement after successful turn");
    leaderSequence = observed.sequence;

    const idleStart = Date.now();
    let idle = await journey.leaderTool("team_sync", { view: "updates" }, leaderSequence);
    if (idle.result.kind === "updates") {
      console.log(JSON.stringify({ round: "idle-remaining-update", changes: { team: idle.result.team_changes.length, worker: idle.result.worker_changes.length, task: idle.result.task_changes.length, alert: idle.result.alerts.length } }));
      idle = await journey.leaderTool("team_sync", { view: "updates" }, idle.resultRequest.sequence);
    }
    const idleElapsed = Date.now() - idleStart;
    assert.equal(idle.result.kind, "caught_up", `Idle sync did not reach caught_up: ${JSON.stringify(idle.result)}`);
    assert(idleElapsed < 2_000, `Settled Worker with unfinished Task waited ${idleElapsed}ms`);
    assert.equal(claimed.task.status, "in_progress");
    leaderSequence = idle.resultRequest.sequence;
    console.log(JSON.stringify({ round: 1, status: "passed", active_wait_ms: 650, idle_return_ms: idleElapsed }));

    // A later Worker-authored progress event must reach an idle leader by delay.
    journey.promptWorker("Record a fresh Task progress note.");
    const workerPrompt = await journey.provider.requestMatching((item) => item.body.model === "worker-scripted", claimed.resultRequest.sequence, MAX_MS);
    const progress = await journey.workerUpdate(workerPrompt, claimed.task, { current_context: "Independent fixture check is still in progress." }, "fixture-progress");
    const automatic = await journey.provider.requestMatching((item) => item.body.model === "scripted", leaderSequence, MAX_MS);
    assert(automatic.at - progress.resultRequest.at < 5_000, "Automatic sync did not resume promptly");
    const beforeAutomaticCursor = journey.hiddenObservation()?.acknowledgedEntryId;
    const automaticEntryId = assertFrameworkPair(automatic.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    assert.equal(journey.hiddenObservation()?.acknowledgedEntryId, beforeAutomaticCursor, "Framework result advanced cursor before a successful turn");
    const beforeAutomaticAnswer = journey.pi.records.length;
    journey.provider.answer(automatic, textResponse("Framework observation received."));
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeAutomaticAnswer, MAX_MS);
    await journey.waitFor(() => journey.hiddenObservation()?.acknowledgedEntryId === automaticEntryId, MAX_MS, "framework cursor acknowledgement after successful turn");
    console.log(JSON.stringify({ round: 2, status: "passed", automatic_request_sequence: automatic.sequence }));

    const beforeManual = journey.pi.sessionEntries();
    const cursorBeforeManual = journey.hiddenObservation()?.teamEventCursor;
    const requestBeforeManual = latestSequence(journey.provider);
    const manual = await journey.pi.command("prompt", { message: "/teamsync" });
    assert.equal(manual.success, true);
    await delay(500);
    assertNoNewRequest(journey.provider, requestBeforeManual, "scripted");
    assert.deepEqual(journey.pi.sessionEntries(), beforeManual, "Empty /teamsync authored model-visible Session history");
    assert.equal(journey.hiddenObservation()?.teamEventCursor, cursorBeforeManual);
    assert(journey.pi.records.slice(-12).some((event) => JSON.stringify(event).includes("No Team updates")), "Empty /teamsync did not show a UI notice");

    // The pending delayed batch belongs to the old Session only.
    journey.promptWorker("Record one more Task progress note before the leader switches Session.");
    const laterWorkerPrompt = await journey.provider.requestMatching((item) => item.body.model === "worker-scripted", progress.resultRequest.sequence, MAX_MS);
    await journey.workerUpdate(laterWorkerPrompt, progress.task, { current_context: "The fixture is waiting for review." }, "fixture-later-progress");
    const oldSession = (await journey.pi.command("get_state")).data.sessionFile;
    const oldCursor = journey.hiddenObservation()?.teamEventCursor;
    const beforeSwitch = latestSequence(journey.provider);
    const switched = await journey.pi.command("new_session");
    assert.equal(switched.success, true);
    await journey.pi.command("get_state");
    await delay(900);
    assertNoNewRequest(journey.provider, beforeSwitch, "scripted");
    assert.equal(journey.hiddenObservation()?.teamEventCursor, oldCursor, "A switched-away Session advanced the old cursor");
    const resumed = await journey.pi.command("switch_session", { sessionPath: oldSession });
    assert.equal(resumed.success, true);
    assert.equal(resumed.data.cancelled, false);
    await journey.pi.command("get_state");
    const replayed = await journey.provider.requestMatching((item) => item.body.model === "scripted", beforeSwitch, MAX_MS);
    const replayedEntryId = assertFrameworkPair(replayed.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    const beforeReplayAnswer = journey.pi.records.length;
    journey.provider.answer(replayed, textResponse("Resumed Session observed its pending Team update."));
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeReplayAnswer, MAX_MS);
    await journey.waitFor(() => journey.hiddenObservation()?.acknowledgedEntryId === replayedEntryId, MAX_MS, "resumed framework cursor acknowledgement");
    const tuiSession = (await journey.pi.command("get_state")).data.sessionFile;
    const providerCountBeforeTui = journey.provider.requests.length;
    await journey.pi.close();
    journey.pi = undefined;
    const { stdout: tuiOutput } = await execFileAsync("python3", [
      path.join(HERE, "tui-empty.py"), process.execPath, PI_CLI, tuiSession,
      path.join(PACKAGE, "extensions/index.ts"), journey.box.path("project"), journey.box.path("home"), journey.box.path("agent"),
      journey.tmux.childEnvironment().TMUX, journey.tmux.leaderPane,
      `${PI_BIN_DIR}${path.delimiter}${process.env.PATH}`,
    ], { encoding: "utf8", timeout: 30_000 });
    const tui = JSON.parse(tuiOutput.trim());
    assert.equal(tui.tui_empty_notice, true);
    assert.equal(tui.pi_alive, true);
    await delay(150);
    assert.equal(journey.provider.requests.length, providerCountBeforeTui, "Empty TUI command made a provider request");
    console.log(JSON.stringify({ round: 3, status: "passed", empty_manual_provider_requests: 0, switched_session_stale_requests: 0, tui_empty_notice: true }));
  } finally { await journey.close(); }
}

async function countAndManualUpdatesRound() {
  const journey = new Journey({ wait_seconds: 0.2, auto_sync_enabled: true, auto_sync_delay_seconds: 30, auto_sync_update_threshold: 2 });
  try {
    await journey.start();
    let leaderSequence = await journey.establishTeam();
    const assigned = await journey.assignTask(leaderSequence, true);
    const readyBaseline = await journey.leaderTool("team_sync", { view: "snapshot" }, assigned.leaderSequence);
    assert.equal(readyBaseline.result.kind, "snapshot");
    assert(readyBaseline.result.tasks.some((task) => task.id === assigned.task.id));
    assert(readyBaseline.result.tasks.some((task) => task.id === assigned.secondTask.id));
    leaderSequence = readyBaseline.resultRequest.sequence;
    const first = await journey.workerUpdate(assigned.workerRequest, assigned.task, { transition: "claim" }, "count-claim");
    await delay(500);
    assertNoNewRequest(journey.provider, leaderSequence, "scripted");
    journey.promptWorker("Record an independent note on the second Task.");
    const secondPrompt = await journey.provider.requestMatching((item) => item.body.model === "worker-scripted", first.resultRequest.sequence, MAX_MS);
    const second = await journey.workerUpdate(secondPrompt, assigned.secondTask, { current_context: "The second fixture check is ready for review." }, "count-second-task-note");
    const automatic = await journey.provider.requestMatching((item) => item.body.model === "scripted", leaderSequence, 5_000);
    const automaticEntryId = assertFrameworkPair(automatic.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    const autoEntry = journey.pi.sessionEntries().findLast((entry) => entry.type === "custom" && entry.customType === "pi-team-bright.framework-sync-execution");
    assert.equal(autoEntry.data.source, "automatic");
    assert.deepEqual(new Set(autoEntry.data.result.task_changes.map((change) => change.task_id)), new Set([assigned.task.id, assigned.secondTask.id]));
    const afterAutoIndex = journey.pi.records.length;
    journey.provider.answer(automatic, textResponse("Two Worker updates observed."));
    await journey.pi.waitForNew((event) => event.type === "agent_settled", afterAutoIndex, MAX_MS);
    await journey.waitFor(() => journey.hiddenObservation()?.acknowledgedEntryId === automaticEntryId, MAX_MS, "count-triggered framework cursor acknowledgement");
    leaderSequence = automatic.sequence;
    console.log(JSON.stringify({ round: 4, status: "passed", threshold: 2, requests_before_threshold: 0, task_change_ids: autoEntry.data.result.task_changes.map((change) => change.task_id) }));

    journey.promptWorker("Record a third independent Task progress event.");
    const thirdPrompt = await journey.provider.requestMatching((item) => item.body.model === "worker-scripted", second.resultRequest.sequence, MAX_MS);
    await journey.workerUpdate(thirdPrompt, first.task, { current_context: "A third check needs leader review." }, "manual-progress");
    const beforeCommand = latestSequence(journey.provider);
    const command = await journey.pi.command("prompt", { message: "/teamsync" });
    assert.equal(command.success, true);
    const manual = await journey.provider.requestMatching((item) => item.body.model === "scripted", beforeCommand, MAX_MS);
    const manualEntryId = assertFrameworkPair(manual.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    const commandEntry = journey.pi.sessionEntries().findLast((entry) => entry.type === "custom" && entry.customType === "pi-team-bright.framework-sync-execution");
    assert.equal(commandEntry.data.source, "command");
    const beforeManualAnswer = journey.pi.records.length;
    journey.provider.answer(manual, textResponse("Manual Team update observed."));
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeManualAnswer, MAX_MS);
    await journey.waitFor(() => journey.hiddenObservation()?.acknowledgedEntryId === manualEntryId, MAX_MS, "manual framework cursor acknowledgement");
    console.log(JSON.stringify({ round: 5, status: "passed", manual_updated_request_sequence: manual.sequence }));
  } finally { await journey.close(); }
}

async function failureAbortAndReloadChallenge() {
  const journey = new Journey({ wait_seconds: 0.2, auto_sync_enabled: true, auto_sync_delay_seconds: 30, auto_sync_update_threshold: 1000 });
  try {
    await journey.start();
    const baseline = await journey.establishTeam();
    const assigned = await journey.assignTask(baseline);
    const graphUpdate = await journey.leaderTool("team_sync", { view: "updates" }, assigned.leaderSequence);
    assert.equal(graphUpdate.result.kind, "updates");
    const claimed = await journey.workerUpdate(assigned.workerRequest, assigned.task, { transition: "claim" }, "challenge-claim");
    const retrySetting = await journey.pi.command("set_auto_retry", { enabled: false });
    assert.equal(retrySetting.success, true);

    const initialCursor = journey.hiddenObservation()?.acknowledgedEntryId;
    const beforeFailure = latestSequence(journey.provider);
    assert.equal((await journey.pi.command("prompt", { message: "/teamsync" })).success, true);
    const failingRequest = await journey.provider.requestMatching((item) => item.body.model === "scripted", beforeFailure, MAX_MS);
    const failingEntryId = assertFrameworkPair(failingRequest.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    assert.equal(journey.hiddenObservation()?.acknowledgedEntryId, initialCursor);

    journey.promptWorker("Record a newer Task note while the leader provider is unavailable.");
    const workerPrompt = await journey.provider.requestMatching((item) => item.body.model === "worker-scripted", claimed.resultRequest.sequence, MAX_MS);
    const newer = await journey.workerUpdate(workerPrompt, claimed.task, { current_context: "Newer Worker note arrived during provider failure." }, "challenge-newer-note");
    const beforeError = journey.pi.records.length;
    journey.provider.fail(failingRequest);
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeError, MAX_MS, "provider error settlement");
    assert.equal(journey.hiddenObservation()?.acknowledgedEntryId, initialCursor, "Failed provider turn acknowledged its framework result");
    assert.notEqual(journey.hiddenObservation()?.acknowledgedEntryId, failingEntryId);

    const beforeRecovery = latestSequence(journey.provider);
    assert.equal((await journey.pi.command("prompt", { message: "/teamsync" })).success, true);
    const recovery = await journey.provider.requestMatching((item) => item.body.model === "scripted", beforeRecovery, MAX_MS);
    const recoveryEntryId = assertFrameworkPair(recovery.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    const recoveryRecord = journey.pi.sessionEntries().findLast((entry) => entry.type === "custom" && entry.customType === "pi-team-bright.framework-sync-execution");
    assert(recoveryRecord.data.resultText.includes("Newer Worker note arrived during provider failure."), "Recovery omitted the newer Worker event");
    assert.equal(journey.hiddenObservation()?.acknowledgedEntryId, initialCursor);
    const beforeRecoveryAnswer = journey.pi.records.length;
    journey.provider.answer(recovery, textResponse("Recovered Team observation."));
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeRecoveryAnswer, MAX_MS);
    await journey.waitFor(() => journey.hiddenObservation()?.acknowledgedEntryId === recoveryEntryId, MAX_MS, "error recovery acknowledgement");

    journey.promptWorker("Record one more Task note for an aborted leader turn.");
    const abortWorkerPrompt = await journey.provider.requestMatching((item) => item.body.model === "worker-scripted", newer.resultRequest.sequence, MAX_MS);
    await journey.workerUpdate(abortWorkerPrompt, newer.task, { current_context: "Worker note must survive leader abort and reload." }, "challenge-abort-note");
    const beforeAbort = latestSequence(journey.provider);
    assert.equal((await journey.pi.command("prompt", { message: "/teamsync" })).success, true);
    const abortRequest = await journey.provider.requestMatching((item) => item.body.model === "scripted", beforeAbort, MAX_MS);
    const abortEntryId = assertFrameworkPair(abortRequest.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    const cursorBeforeAbort = journey.hiddenObservation()?.acknowledgedEntryId;
    const beforeAbortIndex = journey.pi.records.length;
    assert.equal((await journey.pi.command("abort")).success, true);
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeAbortIndex, MAX_MS, "aborted turn settlement");
    assert.equal(journey.hiddenObservation()?.acknowledgedEntryId, cursorBeforeAbort, "Aborted turn acknowledged its framework result");
    assert.notEqual(journey.hiddenObservation()?.acknowledgedEntryId, abortEntryId);

    const sessionPath = (await journey.pi.command("get_state")).data.sessionFile;
    await journey.pi.close();
    journey.pi = await new PiRpcProcess(journey.box, journey.provider, {
      piCli: PI_CLI, sessionPath,
      env: { ...journey.tmux.childEnvironment(), PATH: `${PI_BIN_DIR}${path.delimiter}${process.env.PATH}`, PI_TEAM_BRIGHT_SHIPPED_EXTENSION: path.join(HERE, "worker-extension.ts"), PI_TEAM_SYNC_WORKER_BOOT_CAPTURE: journey.box.path("worker-boot.jsonl") },
    }).start();
    assert.equal((await journey.pi.command("get_state")).data.sessionFile, sessionPath);
    assert.equal(journey.hiddenObservation()?.acknowledgedEntryId, cursorBeforeAbort, "Reload acknowledged an aborted result");
    const beforeReloadRecovery = latestSequence(journey.provider);
    assert.equal((await journey.pi.command("prompt", { message: "/teamsync" })).success, true);
    const reloadRecovery = await journey.provider.requestMatching((item) => item.body.model === "scripted", beforeReloadRecovery, MAX_MS);
    const reloadEntryId = assertFrameworkPair(reloadRecovery.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    const reloadRecord = journey.pi.sessionEntries().findLast((entry) => entry.type === "custom" && entry.customType === "pi-team-bright.framework-sync-execution");
    assert(reloadRecord.data.resultText.includes("Worker note must survive leader abort and reload."), "Reload lost the aborted Worker update");
    const beforeReloadAnswer = journey.pi.records.length;
    journey.provider.answer(reloadRecovery, textResponse("Reloaded Team observation."));
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeReloadAnswer, MAX_MS);
    await journey.waitFor(() => journey.hiddenObservation()?.acknowledgedEntryId === reloadEntryId, MAX_MS, "reload recovery acknowledgement");
    console.log(JSON.stringify({ challenge: "provider_error_abort_reload", status: "passed", failed_entry_id: failingEntryId, aborted_entry_id: abortEntryId, recovered_entry_id: reloadEntryId }));
  } finally { await journey.close(); }
}

async function boundedAutomaticFailureChallenge() {
  const journey = new Journey({ wait_seconds: 0.2, auto_sync_enabled: true, auto_sync_delay_seconds: 0.2, auto_sync_update_threshold: 1000 });
  try {
    await journey.start();
    const baseline = await journey.establishTeam();
    const assigned = await journey.assignTask(baseline);
    const graphUpdate = await journey.leaderTool("team_sync", { view: "updates" }, assigned.leaderSequence);
    assert.equal(graphUpdate.result.kind, "updates");
    assert.equal((await journey.pi.command("set_auto_retry", { enabled: false })).success, true);
    const cursorBefore = journey.hiddenObservation()?.acknowledgedEntryId;
    await journey.workerUpdate(assigned.workerRequest, assigned.task, { transition: "claim" }, "auto-failure-claim");
    const first = await journey.provider.requestMatching((item) => item.body.model === "scripted", graphUpdate.resultRequest.sequence, MAX_MS);
    const firstEntryId = assertFrameworkPair(first.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    const firstRecord = journey.pi.sessionEntries().findLast((entry) => entry.type === "custom" && entry.customType === "pi-team-bright.framework-sync-execution");
    assert.equal(firstRecord.data.source, "automatic");
    const beforeFirstError = journey.pi.records.length;
    journey.provider.fail(first);
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeFirstError, MAX_MS, "first automatic error settlement");
    assert.equal(journey.hiddenObservation()?.acknowledgedEntryId, cursorBefore);

    const retry = await journey.provider.requestMatching((item) => item.body.model === "scripted", first.sequence, MAX_MS);
    const retryEntryId = assertFrameworkPair(retry.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    assert.equal(retryEntryId, firstEntryId, "Automatic retry created a second canonical record");
    const beforeRetryError = journey.pi.records.length;
    journey.provider.fail(retry);
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeRetryError, MAX_MS, "second automatic error settlement");
    await journey.waitFor(() => journey.pi.records.some((event) => JSON.stringify(event).includes("Automatic Team synchronization stopped after one retry")), MAX_MS, "bounded retry warning");
    await delay(700);
    assertNoNewRequest(journey.provider, retry.sequence, "scripted");
    assert.equal(journey.hiddenObservation()?.acknowledgedEntryId, cursorBefore, "Failed automatic retries acknowledged a result");

    const beforeManual = latestSequence(journey.provider);
    assert.equal((await journey.pi.command("prompt", { message: "/teamsync" })).success, true);
    const manual = await journey.provider.requestMatching((item) => item.body.model === "scripted", beforeManual, MAX_MS);
    const manualEntryId = assertFrameworkPair(manual.body, journey.pi.sessionEntries(), journey.pi.capturedFrameworkContext());
    const manualRecord = journey.pi.sessionEntries().findLast((entry) => entry.type === "custom" && entry.customType === "pi-team-bright.framework-sync-execution");
    assert.equal(manualRecord.data.source, "command");
    assert(manualRecord.data.resultText.includes(assigned.task.id), "Manual recovery omitted the Worker Task");
    const beforeAnswer = journey.pi.records.length;
    journey.provider.answer(manual, textResponse("Manual recovery after bounded automatic failure."));
    await journey.pi.waitForNew((event) => event.type === "agent_settled", beforeAnswer, MAX_MS);
    await journey.waitFor(() => journey.hiddenObservation()?.acknowledgedEntryId === manualEntryId, MAX_MS, "automatic failure manual recovery acknowledgement");
    console.log(JSON.stringify({ challenge: "automatic_failure_retry_manual_recovery", status: "passed", automatic_requests: 2, requests_after_retry: 0, manual_entry_id: manualEntryId }));
  } finally { await journey.close(); }
}

function assertFrameworkPair(payload, entries, contexts) {
  const recordEntry = entries.findLast((entry) => entry.type === "custom" && entry.customType === "pi-team-bright.framework-sync-execution");
  assert(recordEntry, "No canonical framework execution record was persisted");
  const record = recordEntry.data;
  assert.equal(record.provenance, "pi-team-bright/framework");
  assert.equal(record.toolName, "team_sync");
  assert.equal(record.source === "command" || record.source === "automatic", true);
  const callIndex = payload.messages.findIndex((message) => message.role === "assistant" && message.tool_calls?.some((part) => part.id === record.toolCallId && part.function?.name === "team_sync"));
  const result = payload.messages[callIndex + 1];
  assert(callIndex >= 0 && result?.role === "tool" && result.tool_call_id === record.toolCallId && result.content === record.resultText,
    "Provider payload lacks one adjacent framework toolCall/toolResult pair");
  assert.equal(entries.some((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.content?.some((part) => part.type === "toolCall" && part.id === record.toolCallId)), false,
    "Framework call was fabricated as model-authored Session history");
  const captured = contexts.findLast((context) => context.frameworkCalls.some((item) => item.toolCalls.some((part) => part.id === record.toolCallId)));
  assert(captured, "Pi context did not project the framework call");
  const projectedCall = captured.frameworkCalls.find((item) => item.toolCalls.some((part) => part.id === record.toolCallId));
  assert.equal(projectedCall.provider, "pi-team-bright-framework");
  assert.deepEqual(projectedCall.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  assert(captured.toolResults.some((item) => item.toolCallId === record.toolCallId && item.toolName === "team_sync"));
  return recordEntry.id;
}

console.log(JSON.stringify({ pi_version: PI_VERSION, pi_cli: PI_CLI }));
const scenarios = new Set((process.env.PI_TEAM_SYNC_TEST_SCENARIOS || "delay,count,challenge,auto-failure").split(","));
if (scenarios.has("delay")) await activeWaitIdleAndDelayRound();
if (scenarios.has("count")) await countAndManualUpdatesRound();
if (scenarios.has("challenge")) await failureAbortAndReloadChallenge();
if (scenarios.has("auto-failure")) await boundedAutomaticFailureChallenge();
