import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPiArgv } from "../../extensions/index";
import { DurableModelToolBindings } from "../../src/model-tool-contract/durable-model-tool-bindings";
import { DurableModelToolTeamApplication } from "../../src/model-tool-contract/durable-model-tool-team-application";
import { exactLeaderSessionId } from "../../src/model-tool-contract/model-tool-contracts";
import { WorkerLaunchBridge, type WorkerLaunchBridgeDependencies } from "../../src/team-authority/worker-launch-bridge";
import { loadWorkerResourcePolicy, resolveWorkerModelProfile } from "../../src/utils/worker-resource-projection";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import type { Member, TeamConfig } from "../../src/team-authority/contracts";

const createdTeams: string[] = [];
const createdRoots: string[] = [];
const profile = {
  provider: "openrouter",
  model: "openai/gpt-5.1",
  thinking: "low" as const,
  use: "Focused verification",
};

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-profile-adversarial-"));
  createdRoots.push(root);
  return root;
}

function writeSettings(agentDir: string, settings: unknown): void {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
}

function resolverBridge(resolveSettingsModel: WorkerLaunchBridgeDependencies["resolveSettingsModel"] = () => null): WorkerLaunchBridge {
  return new WorkerLaunchBridge({
    buildWorkerArgv: () => [],
    resolveModel: () => null,
    resolveSettingsModel,
    workerAggregate: () => ({ projectTrusted: true }),
    lifecyclePublication: {} as WorkerLaunchBridgeDependencies["lifecyclePublication"],
  });
}

async function createTeam(): Promise<{ name: string; leaderSession: string }> {
  const name = `profile-adversarial-${process.pid}-${Date.now()}-${createdTeams.length}`;
  const leaderSession = path.join(tempRoot(), "leader.jsonl");
  createdTeams.push(name);
  await teams.createTeam(name, leaderSession, "lead", "Adversarial profile boundary checks.");
  return { name, leaderSession };
}

function bindings(team: { name: string; leaderSession: string }, cwd: string): { bindings: DurableModelToolBindings; leaderId: ReturnType<typeof exactLeaderSessionId> } {
  const value = new DurableModelToolBindings();
  const leaderId = exactLeaderSessionId("adversarial-leader-session");
  value.setLeaderSessionFile(leaderId, team.leaderSession);
  value.setLeaderLaunchContext(leaderId, { cwd, projectTrusted: true });
  return { bindings: value, leaderId };
}

function workerMember(team: string): Member {
  return {
    membershipId: teams.newMembershipId(),
    agentId: `reusable-worker@${team}`,
    name: "reusable-worker",
    agentType: "teammate",
    joinedAt: Date.now(),
    sessionFile: path.join(tempRoot(), "worker.jsonl"),
    cwd: process.cwd(),
    subscriptions: [],
    isActive: true,
    model: `${profile.provider}/${profile.model}`,
    modelProfile: { alias: "fast", provider: profile.provider, model: profile.model, thinking: profile.thinking },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const team of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(team), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(team), { recursive: true, force: true });
  }
  for (const root of createdRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ADR0014 direct production-boundary adversarial checks", () => {
  it("rejects an unknown prototype-name alias without mutating logical Worker or Membership state", async () => {
    const root = tempRoot();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd, { recursive: true });
    writeSettings(agentDir, { pi_team_bright: { model_profiles: { fast: profile, review: { ...profile, model: "openai/gpt-5.2" } } } });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    const team = await createTeam();
    const { bindings: modelBindings, leaderId } = bindings(team, cwd);
    const app = new DurableModelToolTeamApplication(modelBindings, resolverBridge());
    const before = await teams.readConfig(team.name);

    const outcome = await app.ensureWorker(leaderId, { name: "prototype-name", scope: "Should never be created.", model: "prototype-name" });

    expect(outcome).toMatchObject({ kind: "invalid_model_profile", validModelProfiles: [{ alias: "fast" }, { alias: "review" }] });
    expect(await teams.readConfig(team.name)).toEqual(before);
    expect(await teams.readLogicalWorker(team.name, "prototype-name")).toEqual({ kind: "not_found" });
    expect((await teams.readConfig(team.name)).members.filter((member) => member.name === "prototype-name")).toHaveLength(0);
  });

  it("removes a malformed project profile override instead of falling back to its global alias", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    writeSettings(agentDir, {
      pi_team_bright: {
        model_profiles: {
          shadowed: profile,
          globalOnly: { ...profile, model: "openai/gpt-5.2" },
        },
      },
    });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
      pi_team_bright: { model_profiles: { shadowed: { ...profile, thinking: "not-a-thinking-level" } } },
    }));

    const policy = loadWorkerResourcePolicy({ cwd, projectTrusted: true, agentDir });

    expect(policy.modelProfiles).toEqual({ globalOnly: { ...profile, model: "openai/gpt-5.2" } });
    expect(policy.diagnostics).toContain("pi_team_bright.model_profiles.shadowed is invalid and was ignored.");
  });

  it("refuses an explicit profile when registry evidence is missing and settings validation cannot confirm it", () => {
    const resolveSettingsModel = vi.fn(() => null);
    const bridge = resolverBridge(resolveSettingsModel);

    expect(() => bridge.resolveInitialWorkerModel(
      {
        teamName: "team",
        workerName: "worker",
        scope: "Verify selection.",
        cwd: process.cwd(),
        model: "fast",
        availableModelKeys: undefined,
      },
      {} as TeamConfig,
      { projectTrusted: true, modelProfiles: { fast: profile } },
    )).toThrow(/cannot verify availability because Pi's current model catalog is unavailable/i);
    expect(resolveSettingsModel).not.toHaveBeenCalled();
  });

  it("reuses a bound Worker after the settings catalog changes", async () => {
    const root = tempRoot();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd, { recursive: true });
    writeSettings(agentDir, { pi_team_bright: { model_profiles: { fast: profile } } });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

    const team = await createTeam();
    const existing = workerMember(team.name);
    await teams.ensureLogicalWorker(team.name, {
      name: existing.name,
      scope: "Keep the existing assignment.",
      modelProfile: existing.modelProfile,
    });
    await teams.addMember(team.name, existing);

    writeSettings(agentDir, { pi_team_bright: { model_profiles: { replacement: { ...profile, model: "openai/gpt-5.2" } } } });
    const launchBridge = {
      resolveInitialWorkerModel: vi.fn(),
      ensureWorker: vi.fn(async () => ({ action: "reused", member: existing, membershipId: existing.membershipId! })),
    } as unknown as WorkerLaunchBridge;
    const { bindings: modelBindings, leaderId } = bindings(team, cwd);
    const app = new DurableModelToolTeamApplication(modelBindings, launchBridge);

    const outcome = await app.ensureWorker(leaderId, { name: existing.name, scope: "Keep the existing assignment." });

    expect(outcome).toMatchObject({ kind: "reused", worker: { name: existing.name, model: "fast" } });
    expect(launchBridge.resolveInitialWorkerModel).not.toHaveBeenCalled();
    expect(launchBridge.ensureWorker).toHaveBeenCalledWith(expect.objectContaining({ modelProfile: existing.modelProfile }));
  });

  it("does not add an off thinking flag when defaults are omitted", () => {
    expect(buildPiArgv(["pi"], undefined, undefined)).toEqual(["pi"]);
    expect(buildPiArgv(["pi"], "openrouter/openai/gpt-5.1", undefined)).toEqual([
      "pi", "--model", "openrouter/openai/gpt-5.1",
    ]);
    expect(resolverBridge().resolveInitialWorkerModel(
      { teamName: "team", workerName: "worker", scope: "Use native defaults.", cwd: process.cwd() },
      {} as TeamConfig,
      { projectTrusted: true, modelProfiles: { fast: profile } },
    )).toEqual({});
    expect(resolverBridge().resolveInitialWorkerModel(
      { teamName: "team", workerName: "worker", scope: "Use the configured default.", cwd: process.cwd() },
      { defaultModel: "openrouter/openai/gpt-5.1" } as TeamConfig,
      { projectTrusted: true, modelProfiles: {} },
    )).toEqual({
      model: "openrouter/openai/gpt-5.1",
      binding: { provider: "openrouter", model: "openai/gpt-5.1" },
    });
  });

  it("keeps the profile resolver own-property bounded for prototype names", () => {
    expect(() => resolveWorkerModelProfile("constructor", { fast: profile })).toThrow(/is not configured/i);
    expect(() => resolveWorkerModelProfile("__proto__", { fast: profile })).toThrow(/is not configured/i);
  });
});
