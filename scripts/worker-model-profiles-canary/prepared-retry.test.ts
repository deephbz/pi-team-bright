import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerLaunchBridge } from "../../src/utils/worker-launch-bridge";
import { DurableModelToolBindings } from "../../src/model-tool-contract/durable-model-tool-bindings";
import { DurableModelToolTeamApplication } from "../../src/model-tool-contract/durable-model-tool-team-application";
import { exactLeaderSessionId } from "../../src/model-tool-contract/model-tool-contracts";
import { clearAdapterCache, setAdapter } from "../../src/adapters/terminal-registry";
import type { TerminalAdapter } from "../../src/utils/terminal-adapter";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";


const teamNames: string[] = [];

async function team(defaultModel?: string) {
  const name = `profile-prepared-retry-${process.pid}-${Date.now()}`;
  teamNames.push(name);
  const workspace = paths.teamDir(name);
  fs.mkdirSync(path.join(workspace, ".beads"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".beads", "metadata.json"), JSON.stringify({ database: "dolt", backend: "dolt", dolt_database: name, project_id: name }));
  await teams.createTeam(name, `/tmp/${name}-lead.jsonl`, "lead", "Prepared retry proof", defaultModel, undefined, workspace, `authority-${name}`, {
    schema: "pi-teams-beads-authority/1", backend: "dolt", database: "dolt", doltDatabase: name, projectId: name,
  }, undefined, { backend: "profile-retry", leadTarget: { backend: "profile-retry", kind: "pane", targetId: "leader" } });
  return name;
}

function adapter() {
  const argv: string[][] = [];
  const terminal: TerminalAdapter = {
    name: "profile-retry",
    isDirectCarrier: () => true,
    detect: () => true,
    spawn: () => "worker-pane",
    kill() {},
    isAlive: () => false,
    setTitle() {},
    supportsWindows: () => false,
    spawnWindow: () => "worker-window",
    setWindowTitle() {},
    killWindow() {},
    isWindowAlive: () => false,
  };
  return { terminal, argv };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearAdapterCache();
  for (const name of teamNames.splice(0)) {
    fs.rmSync(paths.teamDir(name), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(name), { recursive: true, force: true });
  }
});

describe("model role prepared retry", () => {
  it("keeps selected thinking on prepared retry and omits it for bound recovery", async () => {
    const name = await team();
    const { terminal, argv } = adapter();
    setAdapter(terminal);
    let observations = 0;
    const lifecyclePublication = {
      readEventCursor: () => "0",
      recordWorkerPrepared: async () => ({ cursor: "1" }),
      recordWorkerStopped: async () => ({ cursor: "1" }),
      recordWorkerSessionBound: async () => ({ cursor: "1" }),
      recordWorkerFailed: async () => ({ cursor: "1" }),
      observeWorkerStartup: async () => {
        observations += 1;
        return observations >= 3
          ? { observed: true as const, carrier: "session_bound" as const, runtime: "observed" as const, cursor: "1" }
          : { observed: false as const, carrier: "prepared" as const, runtime: "not_observed" as const, cursor: "1", reason: "timeout" as const };
      },
    };
    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: (model, thinking) => {
        argv.push([model ?? "", thinking ?? ""]);
        return ["pi", ...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])];
      },
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({
        projectTrusted: false,
      }),
      lifecyclePublication,
    });
    const first = await bridge.ensureWorker({
      teamName: name,
      workerName: "review",
      scope: "Review profile",
      cwd: process.cwd(),
      modelProfile: { alias: "review", provider: "fixture", model: "review-model", thinking: "high" },
    });
    await bridge.ensureWorker({ teamName: name, workerName: "review", scope: "Review profile", cwd: process.cwd() });
    expect(argv.slice(0, 2)).toEqual([["fixture/review-model", "high"], ["fixture/review-model", "high"]]);

    expect(first.member.thinking).toBe("high");
  });

  it("recreates a pinned logical Worker in a legacy Team without using its raw default", async () => {
    const name = await team("fixture/old-raw-default");
    const { terminal, argv } = adapter();
    setAdapter(terminal);
    const binding = { alias: "review", provider: "fixture", model: "review-model", thinking: "high" as const };
    await teams.ensureLogicalWorker(name, { name: "review", scope: "Review work", modelProfile: binding });
    expect((await teams.readConfig(name)).members.filter(member => member.agentType === "teammate")).toHaveLength(0);

    const bridge = createWorkerLaunchBridge({
      buildWorkerArgv: (model, thinking) => {
        argv.push([model ?? "", thinking ?? ""]);
        return ["pi", ...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])];
      },
      resolveModel: () => null,
      resolveSettingsModel: () => null,
      workerAggregate: () => ({ projectTrusted: false }),
      lifecyclePublication: {
        readEventCursor: () => "0",
        recordWorkerPrepared: async () => ({ cursor: "1" }),
        recordWorkerStopped: async () => ({ cursor: "1" }),
        recordWorkerSessionBound: async () => ({ cursor: "1" }),
        recordWorkerFailed: async () => ({ cursor: "1" }),
        observeWorkerStartup: async () => ({ observed: false as const, carrier: "prepared" as const,
          runtime: "not_observed" as const, cursor: "1", reason: "timeout" as const }),
      },
    });
    const modelBindings = new DurableModelToolBindings();
    const leaderId = exactLeaderSessionId(`prepared-retry-${name}`);
    modelBindings.setLeaderSessionFile(leaderId, `/tmp/${name}-lead.jsonl`);
    modelBindings.setLeaderLaunchContext(leaderId, { cwd: process.cwd(), projectTrusted: false });
    const app = new DurableModelToolTeamApplication(modelBindings, bridge);

    const outcome = await app.ensureWorker(leaderId, { name: "review", scope: "Review work" });

    expect(outcome).toMatchObject({ kind: "created", worker: { name: "review", modelRole: "review" } });
    expect(argv[0]).toEqual(["fixture/review-model", "high"]);
    expect((await teams.readConfig(name)).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "review", modelProfile: binding }),
    ]));
  });
});
