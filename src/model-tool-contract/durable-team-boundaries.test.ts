import { terminalFixture } from "../../test/terminal-fixture";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as teams from "../utils/teams";
import * as paths from "../utils/paths";
import { clearAdapterCache, setAdapter } from "../adapters/terminal-registry";
import { DurableGraphTaskAuthority } from "../adapters/durable-graph-task-authority";
import { DurableTaskMutationPublication } from "../adapters/durable-task-mutation-publication";
import { DurableGraphTaskOrchestration } from "../task-authority/graph-orchestration";
import { createDurableCoordinationQueries } from "../adapters/durable-coordination-queries";
import { CoordinationObservationService, createDurableCoordinationObservationStore } from "../coordination/observation-service";
import { projectNonterminalTaskIds, projectTaskChanges } from "../coordination/task-change-projection";
import { DurableModelToolTeamPort, type ModelToolLifecycle } from "./durable-model-tool-port";
import { exactLeaderSessionId } from "./model-tool-contracts";
import { registerModelToolJourney } from "./pi-registration";

const names: string[] = [];
const roots: string[] = [];
function fixture(lifecycle: ModelToolLifecycle = { stopWorker: vi.fn(), shutdownTeam: vi.fn() }) {
  const name = `team-boundary-${process.pid}-${names.length}`; names.push(name);
  const root = fs.mkdtempSync(path.join(process.env.PI_TEAMS_VITEST_HOME!, "team-boundary-")); roots.push(root);
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true }); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ pi_team_bright: { team: { date_prefix: false } } }));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const renamePane = vi.fn();
  setAdapter(terminalFixture({ name: "herdr", isAlive: async () => true, renamePane }));
  const publication = new DurableTaskMutationPublication();
  const authority = new DurableGraphTaskAuthority();
  const graph = new DurableGraphTaskOrchestration(authority, publication, publication, publication);
  const observation = new CoordinationObservationService(createDurableCoordinationQueries(graph), { projectNonterminalTaskIds, projectTaskChanges }, createDurableCoordinationObservationStore());
  const launchBridge = { ensureWorker: vi.fn(), resolveInitialWorkerModel: vi.fn().mockReturnValue({}) };
  const port = new DurableModelToolTeamPort(launchBridge as any, lifecycle, graph, undefined, observation);
  const sessionFile = path.join(root, "lead.jsonl"), id = exactLeaderSessionId(`${name}-session`);
  port.setLeaderSessionFile(id, sessionFile); port.setLeaderLaunchContext(id, { cwd, projectTrusted: true });
  return { name, port, authority, id, sessionFile, cwd, agentDir, renamePane, launchBridge };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearAdapterCache(); for (const name of names.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true }); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("creates graph authority and Team durably before the callback and waits for its completion", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => enter = r), gate = new Promise<void>(r => release = r);
  const callback = vi.fn(async () => { enter(); await gate; });
  const f = fixture({ teamCreated: callback, stopWorker: vi.fn(), shutdownTeam: vi.fn() });
  let settled = false;
  const operation = f.port.createTeam(f.id, { name: f.name, purpose: "Verify durable callback ordering." }).then(result => { settled = true; return result; });
  await entered;
  expect(await teams.readConfig(f.name)).toMatchObject({ members: [{ name: "team-lead", sessionFile: f.sessionFile }] });
  expect(await f.authority.readTasks(f.name)).toEqual([]); expect(settled).toBe(false); expect(f.renamePane).not.toHaveBeenCalled();
  release(); expect(await operation).toMatchObject({ kind: "created" });
  expect(callback).toHaveBeenCalledWith(f.name, f.sessionFile); expect(f.renamePane).toHaveBeenCalledExactlyOnceWith("leader-pane", `leader-${f.name}`);
});

it("maps callback rejection while retaining the created Team and readable graph", async () => {
  const f = fixture({ teamCreated: async () => { throw new Error("callback publication failed"); }, stopWorker: vi.fn(), shutdownTeam: vi.fn() });
  expect(await f.port.createTeam(f.id, { name: f.name, purpose: "Retain durable creation." })).toEqual({ kind: "unavailable", reason: "team_authority_unavailable", message: "callback publication failed" });
  expect(await teams.readConfig(f.name)).toMatchObject({ members: [{ name: "team-lead", sessionFile: f.sessionFile }] });
  expect(await f.authority.readTasks(f.name)).toEqual([]); expect(f.renamePane).not.toHaveBeenCalled();
});

it("keeps the created Team usable when pane naming fails", async () => {
  const f = fixture(); f.renamePane.mockImplementation(() => { throw new Error("pane rename unavailable"); });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await f.port.createTeam(f.id, { name: f.name, purpose: "Non-blocking naming." })).toMatchObject({ kind: "created" });
  expect(teams.teamExists(f.name)).toBe(true); expect(await f.authority.readTasks(f.name)).toEqual([]);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("pane rename unavailable"));
});

it.each([false, true])("projects snapshot model roles with exact leader trust=%s", async projectTrusted => {
  const f = fixture(); await teams.createTeam(f.name, f.sessionFile, "lead");
  fs.writeFileSync(path.join(f.agentDir, "settings.json"), JSON.stringify({ pi_team_bright: { model_roles: {
    global: { model: "fixture/global", thinking: "low", use: "Global only" }, shared: { model: "fixture/shared", thinking: "low", use: "Global shared" },
  } } }));
  fs.writeFileSync(path.join(f.cwd, ".pi/settings.json"), JSON.stringify({ pi_team_bright: { model_roles: {
    project: { model: "fixture/project", thinking: "medium", use: "Project only" }, shared: { model: "fixture/override", thinking: "high", use: "Project override" },
  } } }));
  f.port.setLeaderLaunchContext(f.id, { cwd: f.cwd, projectTrusted });
  expect(await f.port.readSnapshot(f.id)).toMatchObject({ kind: "snapshot", modelRoles: projectTrusted
    ? [{ name: "global", use: "Global only" }, { name: "project", use: "Project only" }, { name: "shared", use: "Project override" }]
    : [{ name: "global", use: "Global only" }, { name: "shared", use: "Global shared" }] });
});

it.each([false, true])("propagates leader cwd and exact trust through registered ensure_worker=%s", async projectTrusted => {
  const f = fixture(); await teams.createTeam(f.name, f.sessionFile, "lead");
  fs.writeFileSync(path.join(f.cwd, ".pi/settings.json"), JSON.stringify({ pi_team_bright: { model_roles: { project: { model: "fixture/selected", thinking: "low", use: "Project Worker" } } } }));
  f.launchBridge.ensureWorker.mockResolvedValue({ action: "created", member: { name: "worker", agentType: "teammate", sessionFile: "/synthetic/worker" }, membershipId: "worker-membership", target: { backend: "fixture", kind: "pane", targetId: "worker-pane" }, startup: { observed: true } });
  const tools = new Map<string, any>(); registerModelToolJourney({ registerTool: tool => tools.set(tool.name, tool) }, f.port);
  const result = await tools.get("ensure_worker").execute("ensure", { name: "worker", scope: "Fixture scope." }, undefined, undefined, {
    cwd: f.cwd, isProjectTrusted: () => projectTrusted, modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "selected" }, { provider: "fixture", id: "not-in-result" }] },
    sessionManager: { getSessionId: () => f.id, getSessionFile: () => f.sessionFile },
  });
  expect(f.launchBridge.ensureWorker).toHaveBeenCalledOnce();
  const request = f.launchBridge.ensureWorker.mock.calls[0][0];
  expect(request).toMatchObject({ teamName: f.name, workerName: "worker", scope: "Fixture scope.", cwd: f.cwd, launchEnvironment: { PI_TEAM_BRIGHT_MODEL_TOOL: "1" } });
  expect(request.availableModelKeys).toEqual(new Set(["fixture/selected", "fixture/not-in-result"]));
  expect(JSON.stringify(result)).not.toContain("fixture/not-in-result");
  expect(request.workerAggregate(f.cwd)).toMatchObject({ projectTrusted, modelRoleSettings: { roles: projectTrusted ? { project: { model: "fixture/selected", thinking: "low", use: "Project Worker" } } : {} } });
});
