#!/usr/bin/env node
/**
 * Independent ADR0014 receipt verifier.
 *
 * The live canary writes native evidence into a private run root. This program
 * derives claims from Pi Session JSONL, Team snapshots/events, tool records,
 * and exact carrier records. The receipt only locates inputs and states the
 * profile fixture. It does not supply pass booleans.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function fail(message) { throw new Error(message); }
function check(condition, name) { if (!condition) fail(`failed:${name}`); }

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) fail(`Invalid argument near ${key ?? "end"}.`);
    values.set(key, value);
  }
  const rawDir = values.get("--raw-dir"); const receipt = values.get("--receipt");
  if (!rawDir || !receipt) fail("Usage: assert.mjs --raw-dir <private-dir> --receipt <receipt.json>");
  return { rawDir: resolve(rawDir), receipt: resolve(receipt) };
}

function json(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { fail(`Cannot read JSON evidence: ${error instanceof Error ? error.message : "invalid JSON"}`); }
}

function jsonl(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => {
      try { return { ...JSON.parse(line), __line: index }; }
      catch { fail(`Invalid JSONL at ${path}:${index + 1}`); }
    });
  } catch (error) { fail(`Cannot read JSONL evidence: ${error instanceof Error ? error.message : "unreadable"}`); }
}

function privatePath(rawDir, value, name) {
  check(typeof value === "string" && value.length > 0, `${name}_path_present`);
  check(!isAbsolute(value), `${name}_path_relative`);
  const path = resolve(rawDir, value);
  check(path.startsWith(`${rawDir}/`), `${name}_path_private`);
  check(statSync(path).isFile(), `${name}_file_present`);
  return path;
}

function scanKeys(value, path = "evidence") {
  if (Array.isArray(value)) return value.forEach((item, index) => scanKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    check(!/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|password|secret|credential)/i.test(key), `no_credential_key:${path}.${key}`);
    scanKeys(nested, `${path}.${key}`);
  }
}

function toolName(row) { return row.toolName ?? row.tool; }
function toolInput(row) { return row.input ?? row.parameters ?? row.call ?? {}; }
function toolDetails(row) { return row.details ?? row.result?.details ?? row.result; }
function toolRows(rows, name) { return rows.filter((row) => toolName(row) === name); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["at", "timestamp", "joinedAt", "createdAt", "updatedAt", "runtime", "terminalTarget", "tmuxPaneId", "windowId"].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, stable(nested)]));
}
function canonical(value) { return JSON.stringify(stable(value)); }
function sessionEntries(rows) { return rows.filter((row) => row.type !== "session"); }
function sessionMessages(rows) { return sessionEntries(rows).filter((row) => row.type === "message"); }
function rowTime(row) {
  const value = row.timestamp ?? row.at ?? "";
  return typeof value === "number" ? value : Date.parse(value);
}
function modelMatches(profile, provider, model) {
  return provider === profile.provider && (model === profile.model || model?.startsWith(`${profile.model}-`));
}
function nativeAssistant(rows, after = -Infinity) {
  return sessionMessages(rows).find((row) => row.message?.role === "assistant" && rowTime(row) > after && row.message.provider && row.message.model);
}

function assertInitialProfiles(receipt, profiles, rawDir) {
  for (const [alias, profile] of Object.entries(profiles)) {
    const sessionPath = privatePath(rawDir, receipt.evidence.worker_sessions?.[alias], `${alias}_worker_session`);
    const rows = jsonl(sessionPath);
    const modelChange = rows.find((row) => row.type === "model_change");
    const thinkingChange = rows.find((row) => row.type === "thinking_level_change");
    check(modelChange?.provider && modelChange.modelId, `${alias}_initial_model_change`);
    check(thinkingChange?.thinkingLevel, `${alias}_initial_thinking_change`);
    check(modelMatches(profile, modelChange.provider, modelChange.modelId), `${alias}_initial_model_profile`);
    check(thinkingChange.thinkingLevel === profile.thinking, `${alias}_initial_thinking_profile`);
    const assistant = nativeAssistant(rows, Math.max(rowTime(modelChange), rowTime(thinkingChange)) - 1);
    check(assistant, `${alias}_initial_provider_use`);
    check(modelMatches(profile, assistant.message.provider, assistant.message.model), `${alias}_initial_provider_use_profile`);
  }
}

function assertSettings(receipt, rawDir) {
  const settings = json(privatePath(rawDir, receipt.evidence?.profile_settings, "profile_settings"));
  scanKeys(settings);
  const profiles = settings?.pi_team_bright?.model_profiles;
  check(profiles && typeof profiles === "object" && !Array.isArray(profiles), "profile_settings_object");
  check(!Object.hasOwn(settings.pi_team_bright, "default_profile"), "no_default_profile");
  const aliases = Object.keys(profiles).sort();
  check(aliases.length === 2, "two_profiles");
  const expected = new Set((receipt.profiles ?? []).map((profile) => typeof profile === "string" ? profile : profile?.alias));
  for (const alias of aliases) {
    const profile = profiles[alias];
    check(typeof profile.provider === "string" && profile.provider.length > 0, `${alias}_provider`);
    check(typeof profile.model === "string" && profile.model.length > 0, `${alias}_model`);
    check(typeof profile.thinking === "string" && profile.thinking.length > 0, `${alias}_thinking`);
    check(typeof profile.use === "string" && profile.use.length > 0, `${alias}_use`);
    check(expected.has(alias), `${alias}_receipt_profile`);
  }
  const qualified = aliases.map((alias) => `${profiles[alias].provider}/${profiles[alias].model}`);
  check(new Set(qualified).size === 2, "distinct_profile_models");
  return { settings, profiles, aliases };
}

function assertCatalog(toolRowsList, aliases) {
  const created = toolRows(toolRowsList, "team_create").map(toolDetails).find((result) => result?.kind === "team_created");
  const snapshot = toolRows(toolRowsList, "team_sync").map(toolDetails).find((result) => result?.kind === "snapshot");
  check(created?.model_profiles?.map((item) => item.alias).sort().join(",") === aliases.join(","), "create_catalog");
  check(snapshot?.model_profiles?.map((item) => item.alias).sort().join(",") === aliases.join(","), "snapshot_catalog");
  const updates = toolRows(toolRowsList, "team_sync").map(toolDetails).filter((result) => result?.kind === "updates");
  check(updates.length > 0 && updates.every((result) => !Object.hasOwn(result, "model_profiles")), "updates_no_catalog");
}

function snapshotState(snapshot) {
  const value = snapshot.snapshot ?? snapshot;
  const workers = value.logicalWorkers ?? value.workers ?? [];
  const members = value.members ?? value.team?.members ?? [];
  return {
    logicalWorkers: workers.map((worker) => ({ name: worker.name, scope: worker.scope, ...(worker.modelProfile ? { modelProfile: worker.modelProfile } : {}) })),
    members: members.map((member) => ({ name: member.name, agentType: member.agentType, isActive: member.isActive, ...(member.modelProfile ? { modelProfile: member.modelProfile } : {}) })),
  };
}

function assertInvalidAlias(toolRowsList, evidence, rawDir, before, after) {
  const invalid = toolRowsList.find((row) => toolName(row) === "ensure_worker" && toolInput(row).model === evidence.invalid_alias);
  check(invalid, "invalid_alias_tool_call");
  const result = toolDetails(invalid);
  check(result?.kind === "refused" && result.reason === "invalid_model_profile", "invalid_alias_refused");
  check(Array.isArray(result.valid_model_profiles) && result.valid_model_profiles.length === 2, "invalid_alias_choices");
  check(canonical(snapshotState(before)) === canonical(snapshotState(after)), "invalid_alias_snapshot_unchanged");
  check(!snapshotState(after).logicalWorkers.some((worker) => worker.name === toolInput(invalid).name), "invalid_alias_no_logical_worker");
  check(!snapshotState(after).members.some((member) => member.name === toolInput(invalid).name), "invalid_alias_no_membership");
  const carrier = jsonl(privatePath(rawDir, evidence.carrier_jsonl, "carrier"));
  const invalidCarrier = carrier.filter((row) => row.worker === toolInput(invalid).name && ["prepared", "carrier_start_accepted", "session_bound", "carrier_target_persisted"].includes(row.phase));
  check(invalidCarrier.length === 0, "invalid_alias_no_carrier");
  const provider = jsonl(privatePath(rawDir, evidence.provider_jsonl, "provider"));
  check(provider.filter((row) => row.worker === toolInput(invalid).name && row.kind === "provider_request").length === 0, "invalid_alias_no_provider_request");
  const sessions = json(privatePath(rawDir, evidence.session_inventory, "session_inventory"));
  check(!sessions.some((path) => String(path).includes(toolInput(invalid).name)), "invalid_alias_no_session");
}

function assertDag(toolRowsList, events) {
  const graphRow = toolRowsList.find((row) => toolName(row) === "task_graph_apply");
  check(graphRow, "dag_tool_call");
  const input = toolInput(graphRow); const details = toolDetails(graphRow);
  check(Array.isArray(input.tasks) && input.tasks.length >= 3, "dag_tasks_present");
  check(input.tasks.every((task) => !Object.hasOwn(task, "model")), "dag_input_modelless");
  const tasks = Object.values(details?.tasks_by_key ?? {});
  check(tasks.length >= 3 && tasks.every((task) => !Object.hasOwn(task, "model") && !Object.hasOwn(task, "model_alias")), "dag_result_modelless");
  const byId = new Map(input.tasks.map((task) => [task.key, task]));
  const workerEvents = events.filter((event) => event.kind === "task_transition" || event.type === "task_transition");
  for (const task of input.tasks) {
    const transitions = workerEvents.filter((event) => (event.taskId ?? event.task_id ?? event.key) === (task.id ?? task.key));
    check(transitions.some((event) => event.actor === task.assignee && event.transition === "claim"), `dag_claim_${task.key}`);
    check(transitions.some((event) => event.actor === task.assignee && ["goal_achieved", "complete"].includes(event.transition)), `dag_complete_${task.key}`);
  }
  const terminal = input.tasks.find((task) => Array.isArray(task.needs) && task.needs.length >= 2)
    ?? input.tasks.find((task) => Array.isArray(task.needs) && task.needs.length >= 1);
  check(terminal, "dag_dependency_target");
  const terminalComplete = workerEvents.find((event) => (event.taskId ?? event.task_id ?? event.key) === terminal.key && ["goal_achieved", "complete"].includes(event.transition));
  check(terminalComplete, "dag_dependency_target_complete");
  for (const dependency of terminal.needs) {
    const dependencyComplete = workerEvents.find((event) => (event.taskId ?? event.task_id ?? event.key) === dependency && ["goal_achieved", "complete"].includes(event.transition));
    check(dependencyComplete && dependencyComplete.__line < terminalComplete.__line, `dag_dependency_${dependency}`);
  }
  check([...byId.values()].every((task) => typeof task.assignee === "string"), "dag_assignees");
}

function assertReuse(toolRowsList, carrier, provider, workerAlias, snapshots) {
  const reuse = toolRowsList.find((row) => toolName(row) === "ensure_worker" && toolDetails(row)?.effect === "reused" && (toolInput(row).model === workerAlias || toolDetails(row)?.worker?.model === workerAlias));
  check(reuse, "reuse_result");
  const conflicts = toolRowsList.filter((row) => toolName(row) === "ensure_worker" && toolInput(row).name === toolInput(reuse).name && toolInput(row).model && toolInput(row).model !== workerAlias);
  check(conflicts.length > 0, "reuse_conflict_call");
  check(conflicts.some((row) => row.isError === true || toolDetails(row)?.kind === "refused"), "reuse_conflict_refused");
  const conflictBefore = snapshots.find((row) => row.label === "before_conflict")?.snapshot;
  const conflictAfter = snapshots.find((row) => row.label === "after_conflict")?.snapshot;
  check(conflictBefore && conflictAfter && canonical(snapshotState(conflictBefore)) === canonical(snapshotState(conflictAfter)), "reuse_conflict_no_state_change");
  const worker = toolInput(reuse).name;
  const returnedAt = Date.parse(carrier.find((row) => row.worker === worker && row.phase === "reuse_returned")?.at ?? "");
  const reuseAt = Date.parse(reuse.at ?? "");
  if (Number.isFinite(reuseAt) && Number.isFinite(returnedAt)) {
    check(provider.filter((row) => row.worker === worker && row.kind === "provider_request" && Number.isFinite(Date.parse(row.at ?? "")) && Date.parse(row.at) >= reuseAt && Date.parse(row.at) <= returnedAt).length === 0, "reuse_no_provider_request");
  }
  check(carrier.filter((row) => row.worker === worker && row.phase === "session_bound").length === 1, "reuse_no_new_session_binding");
}

function assertRecovery(receipt, profiles, toolRowsList, events, carrier, rawDir) {
  const alias = receipt.recovery?.worker_alias;
  check(typeof alias === "string", "recovery_worker_alias");
  const sessionPath = privatePath(rawDir, receipt.evidence.worker_sessions?.[alias], "worker_session");
  const rows = jsonl(sessionPath); const header = rows.find((row) => row.type === "session");
  check(header?.id, "native_session_header");
  const profile = profiles[alias];
  const messages = sessionMessages(rows);
  const modelChanges = rows.filter((row) => row.type === "model_change");
  const thinking = rows.filter((row) => row.type === "thinking_level_change");
  check(modelChanges.length >= 2, "native_model_changes");
  check(thinking.length >= 2, "native_thinking_changes");
  const carrierRows = carrier.filter((row) => row.worker === receipt.recovery.worker_name);
  const initial = carrierRows.find((row) => row.phase === "session_bound" && row.generation === "initial") ?? carrierRows.find((row) => row.phase === "initial_session_bound");
  const stopped = carrierRows.find((row) => row.phase === "carrier_stopped" && row.operation !== "worker_stop");
  const recovered = carrierRows.find((row) => row.phase === "session_bound" && row.generation === "recovery") ?? carrierRows.find((row) => row.phase === "recovery_session_bound");
  check(initial?.membershipId && recovered?.membershipId && initial.membershipId === recovered.membershipId, "recovery_same_membership");
  check(initial?.sessionFile && recovered?.sessionFile && initial.sessionFile === recovered.sessionFile, "recovery_same_session");
  check(initial?.pid && recovered?.pid && initial.pid !== recovered.pid, "recovery_new_process_generation");
  check(stopped, "recovery_exact_carrier_stop");
  check(stopped.membershipId === initial.membershipId && stopped.pid === initial.pid, "recovery_stop_initial_carrier");
  check(!toolRowsList.some((row) => toolName(row) === "worker_stop" && toolInput(row).worker === receipt.recovery.worker_name), "recovery_no_worker_stop");
  const initialAt = rowTime(initial);
  const stoppedAt = rowTime(stopped);
  const recoveryAt = rowTime(recovered);
  check(Number.isFinite(initialAt) && Number.isFinite(stoppedAt) && Number.isFinite(recoveryAt), "recovery_carrier_timestamps");
  check(initialAt < stoppedAt && stoppedAt < recoveryAt, "recovery_stop_before_rebind");

  const latestModelBeforeRecovery = modelChanges.filter((row) => rowTime(row) < recoveryAt).at(-1);
  const latestThinkingBeforeRecovery = thinking.filter((row) => rowTime(row) < recoveryAt).at(-1);
  check(latestModelBeforeRecovery && latestThinkingBeforeRecovery, "recovery_predecessor_selection");
  check(!modelMatches(profile, latestModelBeforeRecovery.provider, latestModelBeforeRecovery.modelId), "human_override_native_changes");
  check(latestThinkingBeforeRecovery.thinkingLevel !== profile.thinking, "human_override_thinking_changes");
  check(modelChanges.every((row) => rowTime(row) <= recoveryAt), "recovery_no_post_model_reset");
  check(thinking.every((row) => rowTime(row) <= recoveryAt), "recovery_no_post_thinking_reset");
  const postRecoveryAssistants = messages.filter((row) => row.message?.role === "assistant" && rowTime(row) > recoveryAt && row.message.provider && row.message.model);
  check(postRecoveryAssistants.length > 0, "recovery_post_reply");
  check(postRecoveryAssistants.every((row) => row.message.provider === latestModelBeforeRecovery.provider && row.message.model === latestModelBeforeRecovery.modelId), "recovery_post_reply_model");
  check(latestThinkingBeforeRecovery.thinkingLevel !== undefined, "recovery_reconstructed_thinking");

  const successorClaim = events.find((event) => event.kind === "task_transition" && event.actor === receipt.recovery.worker_name && event.transition === "claim" && Number.isFinite(Date.parse(event.at ?? "")) && Date.parse(event.at) > recoveryAt);
  check(successorClaim, "recovery_successor_claim");
  for (const prerequisite of receipt.recovery?.prerequisite_task_ids ?? []) {
    const completion = events.find((event) => (event.taskId ?? event.task_id ?? event.key) === prerequisite && ["goal_achieved", "complete"].includes(event.transition) && Number.isFinite(Date.parse(event.at ?? "")) && Date.parse(event.at) < Date.parse(successorClaim.at));
    check(completion, `recovery_prerequisite_${prerequisite}`);
  }
  const successorComplete = events.find((event) => (event.taskId ?? event.task_id ?? event.key) === (successorClaim.taskId ?? successorClaim.task_id ?? successorClaim.key) && event.actor === receipt.recovery.worker_name && ["goal_achieved", "complete"].includes(event.transition) && Date.parse(event.at ?? "") > Date.parse(successorClaim.at));
  check(successorComplete, "recovery_worker_authored_task");
}

function assertTui(rawDir, tui) {
  const collapsed = readFileSync(privatePath(rawDir, tui.collapsed_path, "collapsed_tui"), "utf8");
  const expanded = readFileSync(privatePath(rawDir, tui.expanded_path, "expanded_tui"), "utf8");
  check(collapsed.includes("ensure_worker") && collapsed.includes("settings"), "collapsed_guidance");
  check(!collapsed.includes("model_profiles"), "collapsed_no_example");
  check(expanded.includes("model_profiles") && expanded.includes("alias") && expanded.includes("provider") && expanded.includes("thinking") && expanded.includes("use"), "expanded_example");
  check(!expanded.includes('"model_profiles":') || expanded.includes("settings example:"), "expanded_example_labeled");
  check(tui.model_json_path, "model_json_path");
  const modelJson = readFileSync(privatePath(rawDir, tui.model_json_path, "model_json"), "utf8");
  check(!/settings example|Add aliases in Pi/i.test(modelJson), "model_json_no_human_guidance");
}

function assertCleanup(rawDir, evidence) {
  const cleanup = json(privatePath(rawDir, evidence.cleanup_json, "cleanup"));
  const targets = cleanup.filter((row) => row.kind === "target");
  check(targets.length > 0 && targets.every((row) => row.state === "absent"), "cleanup_exact_targets");
  const settings = cleanup.find((row) => row.kind === "settings");
  check(settings?.beforeSha256 && settings.beforeSha256 === settings.afterSha256, "cleanup_global_settings_unchanged");
  check(cleanup.some((row) => row.kind === "auth_reference" && row.state === "removed"), "cleanup_auth_reference_removed");
  const retained = cleanup.find((row) => row.kind === "retained_evidence");
  check(retained?.path && !isAbsolute(retained.path) && retained.sha256, "cleanup_retained_evidence_recorded");
  const recordedAt = Date.parse(retained.recordedAt ?? "");
  const deletedAt = Date.parse(retained.deletedAt ?? "");
  check(Number.isFinite(recordedAt) && Number.isFinite(deletedAt) && deletedAt >= recordedAt, "cleanup_retained_evidence_order");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const receipt = json(options.receipt);
  check(receipt?.schema === "pi-team-bright-worker-model-profiles-canary/1", "receipt_schema");
  check(receipt?.evidence && typeof receipt.evidence === "object", "raw_evidence_manifest");
  scanKeys(receipt);
  const { profiles, aliases } = assertSettings(receipt, options.rawDir);
  assertInitialProfiles(receipt, profiles, options.rawDir);
  const evidence = receipt.evidence;
  const tool = jsonl(privatePath(options.rawDir, evidence.tool_results_jsonl, "tool_results"));
  const events = jsonl(privatePath(options.rawDir, evidence.team_events_jsonl, "team_events"));
  const snapshots = jsonl(privatePath(options.rawDir, evidence.team_snapshots_jsonl, "team_snapshots"));
  const before = snapshots.find((row) => row.label === "before_invalid")?.snapshot;
  const after = snapshots.find((row) => row.label === "after_invalid")?.snapshot;
  check(before && after, "invalid_alias_snapshots");
  const carrier = jsonl(privatePath(options.rawDir, evidence.carrier_jsonl, "carrier"));
  const provider = jsonl(privatePath(options.rawDir, evidence.provider_jsonl, "provider"));
  assertCatalog(tool, aliases);
  assertInvalidAlias(tool, { ...evidence, invalid_alias: evidence.invalid_alias }, options.rawDir, before, after);
  assertDag(tool, events);
  assertReuse(tool, carrier, provider, evidence.reuse_worker_alias, snapshots);
  assertRecovery(receipt, profiles, tool, events, carrier, options.rawDir);
  assertTui(options.rawDir, evidence.tui);
  assertCleanup(options.rawDir, evidence);
  process.stdout.write(JSON.stringify({ status: "passed", evidence: "native-session-team-tool-carrier" }) + "\n");
}

try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "verification_failed"}\n`); process.exitCode = 1; }
