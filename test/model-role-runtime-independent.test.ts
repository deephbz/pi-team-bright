import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModelRoleSettings, WorkerModelRoleConfigurationError } from "../src/utils/model-role-settings";
import { WorkerLaunchBridge, WorkerLegacyTeamModelDefaultError } from "../src/team-authority/worker-launch-bridge";
import type { TeamConfig } from "../src/team-authority/contracts";

const roots: string[] = [];
function fixture(defaultRole?: string) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "model-role-runtime-independent-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  const settingsFile = path.join(agentDir, "settings.json");
  const write = (roles: Record<string, unknown>) => fs.writeFileSync(settingsFile, JSON.stringify({
    pi_team_bright: { model_roles: roles, ...(defaultRole ? { default_model_role: defaultRole } : {}) },
  }));
  write({ worker: { model: "fixture/model", thinking: "high", use: "Work" } });
  const load = () => loadModelRoleSettings({ cwd: root, agentDir, projectTrusted: false });
  const available = Object.assign(new Set(["fixture/model"]), {
    thinkingLevelsByKey: new Map([["fixture/model", new Set(["low", "high"] as const)]]),
  });
  const bridge = new WorkerLaunchBridge({
    buildWorkerArgv: () => [],
    resolveModel: () => null,
    resolveSettingsModel: () => null,
    workerAggregate: () => ({ projectTrusted: false }),
    lifecyclePublication: {} as never,
  });
  const request = { teamName: "team", workerName: "worker", scope: "work", cwd: root, availableModelKeys: available };
  const team = { members: [] } as unknown as TeamConfig;
  return { write, load, bridge, request, team, available };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Worker model role selection before carrier creation", () => {
  it("returns the same exact initial binding for default and explicit selection", () => {
    const f = fixture("worker");
    const aggregate = { projectTrusted: false, modelRoleSettings: f.load() };
    const implicit = f.bridge.resolveInitialWorkerModel(f.request, f.team, aggregate);
    const explicit = f.bridge.resolveInitialWorkerModel({ ...f.request, modelRole: "worker" }, f.team, aggregate);
    expect(implicit).toEqual(explicit);
    expect(implicit).toEqual({
      model: "fixture/model",
      binding: { alias: "worker", provider: "fixture", model: "model", thinking: "high" },
    });
  });

  it("accepts an explicit name with no default but refuses omission", () => {
    const f = fixture();
    const aggregate = { projectTrusted: false, modelRoleSettings: f.load() };
    expect(f.bridge.resolveInitialWorkerModel({ ...f.request, modelRole: "worker" }, f.team, aggregate))
      .toMatchObject({ binding: { alias: "worker" } });
    expect(() => f.bridge.resolveInitialWorkerModel(f.request, f.team, aggregate))
      .toThrow(WorkerModelRoleConfigurationError);
  });

  it("keeps historical bindings after role deletion and never assigns today's default to a binding-free Worker", () => {
    const f = fixture("worker");
    const original = f.bridge.resolveInitialWorkerModel(f.request, f.team, {
      projectTrusted: false, modelRoleSettings: f.load(),
    });
    f.write({ replacement: { model: "fixture/other", thinking: "low", use: "Other" } });
    const changed = { projectTrusted: false, modelRoleSettings: f.load() };
    expect(f.bridge.resolveInitialWorkerModel({ ...f.request, modelProfile: original.binding }, f.team, changed))
      .toEqual(original);
    expect(f.bridge.resolveInitialWorkerModel({ ...f.request, preserveHistoricalModelSelection: true }, f.team, changed))
      .toEqual({});
    expect(f.bridge.resolveInitialWorkerModel({ ...f.request, modelProfile: {
      provider: "fixture", model: "legacy", thinking: "low",
    } }, f.team, changed)).toEqual({
      model: "fixture/legacy", binding: { provider: "fixture", model: "legacy", thinking: "low" },
    });
  });

  it("refuses a legacy Team raw default even when the new settings define a valid role", () => {
    const f = fixture("worker");
    const oldTeam = { ...f.team, defaultModel: "fixture/old" };
    const aggregate = { projectTrusted: false, modelRoleSettings: f.load() };
    expect(() => f.bridge.resolveInitialWorkerModel({ ...f.request, modelRole: "worker" }, oldTeam, aggregate))
      .toThrow(WorkerLegacyTeamModelDefaultError);
    expect(f.bridge.resolveInitialWorkerModel({ ...f.request, preserveHistoricalModelSelection: true }, oldTeam, aggregate))
      .toEqual({});
  });
});
