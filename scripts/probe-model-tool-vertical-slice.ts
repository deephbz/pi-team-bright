import assert from "node:assert/strict";
import { Check } from "typebox/value";
import {
  CandidateEnsureWorkerParametersSchema,
  CandidateEnsureWorkerResultSchema,
  CandidateTeamCreateParametersSchema,
  CandidateTeamCreateResultSchema,
  CandidateTeamSyncParametersSchema,
  CandidateTeamSyncResultSchema,
} from "../src/model-tool-contract/catalog";
import { parseCandidateToolResult } from "../src/model-tool-contract/result-projection";
import {
  InMemoryModelToolTeamPort,
  registerModelToolJourney,
} from "../src/model-tool-contract/runtime";

type ToolName = "team_create" | "team_sync" | "ensure_worker";
type CapturedTool = {
  name: ToolName;
  parameters: unknown;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

const port = new InMemoryModelToolTeamPort();
const tools = new Map<ToolName, CapturedTool>();
registerModelToolJourney({
  registerTool(tool: CapturedTool) {
    tools.set(tool.name, tool);
  },
}, port);

assert.deepEqual([...tools.keys()], ["team_create", "team_sync", "ensure_worker"]);
assert.equal(tools.get("team_create")?.parameters, CandidateTeamCreateParametersSchema);
assert.equal(tools.get("team_sync")?.parameters, CandidateTeamSyncParametersSchema);
assert.equal(tools.get("ensure_worker")?.parameters, CandidateEnsureWorkerParametersSchema);

assert.equal(Check(CandidateTeamCreateParametersSchema, {
  name: "release-team",
  purpose: "Prepare the release.",
  backend: "beads",
}), false);
assert.equal(Check(CandidateEnsureWorkerParametersSchema, {
  name: "verifier",
  scope: "Own independent release verification.",
  team_name: "release-team",
}), false);
for (const forbidden of ["team_name", "cursor", "continuation", "limit", "wait_ms"]) {
  assert.equal(Check(CandidateTeamSyncParametersSchema, { view: "snapshot", [forbidden]: "forbidden" }), false);
}

function context(sessionId: string) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

async function invoke(tool: ToolName, parameters: unknown, sessionId: string) {
  const registration = tools.get(tool);
  assert.ok(registration);
  const result = await registration.execute(
    `probe-${tool}`,
    parameters,
    undefined,
    undefined,
    context(sessionId),
  );
  const resultSchema = tool === "team_create"
    ? CandidateTeamCreateResultSchema
    : tool === "team_sync"
      ? CandidateTeamSyncResultSchema
      : CandidateEnsureWorkerResultSchema;
  assert.equal(Check(resultSchema, result.details), true, `${tool} details must match its catalog result schema`);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.text, JSON.stringify(result.details));
  assert.deepEqual(parseCandidateToolResult(tool, result.content[0]!.text), result.details);
  return result.details as any;
}

async function probe() {
  const leaderSession = "session-leader-exact";
  const otherSession = "session-other-exact";
  const workerInput = {
    name: "release-verifier",
    scope: "Own independent release verification.",
  };

  const created = await invoke("team_create", {
    name: "release-team",
    purpose: "Prepare and verify the public release.",
  }, leaderSession);
  assert.equal(created.kind, "team_created");
  assert.equal(port.readDebugState().revision, 1);

  const beforeSecondCreate = port.readDebugState();
  const secondCreate = await invoke("team_create", {
    name: "replacement-team",
    purpose: "Replace the active Team.",
  }, leaderSession);
  assert.equal(secondCreate.kind, "refused");
  assert.equal(secondCreate.reason, "active_team_exists");
  assert.deepEqual(port.readDebugState(), beforeSecondCreate);

  const nameConflict = await invoke("team_create", {
    name: "release-team",
    purpose: "Acquire the existing name from another Session.",
  }, otherSession);
  assert.equal(nameConflict.kind, "refused");
  assert.equal(nameConflict.reason, "name_unavailable");
  assert.deepEqual(port.readDebugState(), beforeSecondCreate);

  const hidden = await invoke("team_sync", { view: "snapshot" }, otherSession);
  assert.equal(hidden.kind, "unavailable");
  assert.equal(hidden.reason, "no_active_team");

  const ensured = await invoke("ensure_worker", workerInput, leaderSession);
  assert.deepEqual(ensured, {
    kind: "worker_ensured",
    effect: "created",
    worker: { ...workerInput, carrier: "absent" },
  });
  assert.equal(port.readDebugState().revision, 2);

  const beforeReuse = port.readDebugState();
  const reused = await invoke("ensure_worker", workerInput, leaderSession);
  assert.equal(reused.effect, "reused");
  assert.deepEqual(port.readDebugState(), beforeReuse);

  const conflict = await invoke("ensure_worker", {
    name: workerInput.name,
    scope: "Own release construction instead.",
  }, leaderSession);
  assert.equal(conflict.kind, "refused");
  assert.equal(conflict.reason, "name_scope_conflict");
  assert.deepEqual(port.readDebugState(), beforeReuse);

  const snapshot = await invoke("team_sync", { view: "snapshot" }, leaderSession);
  assert.deepEqual(snapshot.workers, [{ ...workerInput, carrier: "absent", nonterminal_task_ids: [] }]);
  assert.deepEqual(snapshot.tasks, []);

  process.stdout.write(JSON.stringify({
    probe: "model-tool-first-vertical-slice",
    status: "passed",
    finalRevision: port.readDebugState().revision,
    registeredTools: [...tools.keys()],
  }) + "\n");
}

void probe();
