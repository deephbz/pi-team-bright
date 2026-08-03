import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "./paths";
import {
  createTeam,
  deactivateMembership,
  ensureLogicalWorker,
  readConfig,
  readLogicalWorker,
  resolveCurrentLeadSessionBinding,
  writeConfigAtomic,
} from "./teams";
import type { TeamConfig } from "./models";

const roots: string[] = [];

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-preview-authority-"));
  roots.push(directory);
  return directory;
}

function mockTeamPaths(directory: string): void {
  vi.spyOn(paths, "teamDir").mockReturnValue(directory);
  vi.spyOn(paths, "configPath").mockReturnValue(path.join(directory, "config.json"));
  vi.spyOn(paths, "taskDir").mockReturnValue(path.join(directory, "tasks"));
}

describe("preview Team authority coordinates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("persists one stable epoch and logical Workers separately from Membership generations", async () => {
    const directory = root();
    mockTeamPaths(directory);

    const created = await createTeam("preview-team", "/tmp/preview-lead.jsonl", "lead");
    expect(created.epochId).toMatch(/^team_epoch_/);
    expect(created.logicalWorkers).toEqual([]);
    expect((await readConfig("preview-team")).epochId).toBe(created.epochId);

    const beforeMembers = structuredClone(created.members);
    await expect(ensureLogicalWorker("preview-team", { name: "systems", scope: "Team authority" }))
      .resolves.toEqual({ kind: "created", worker: { name: "systems", scope: "Team authority" } });
    await expect(ensureLogicalWorker("preview-team", { name: "systems", scope: "Team authority" }))
      .resolves.toEqual({ kind: "reused", worker: { name: "systems", scope: "Team authority" } });
    const beforeConflict = fs.readFileSync(path.join(directory, "config.json"), "utf8");
    await expect(ensureLogicalWorker("preview-team", { name: "systems", scope: "Different meaning" }))
      .resolves.toEqual({ kind: "scope_conflict", worker: { name: "systems", scope: "Team authority" } });
    expect(fs.readFileSync(path.join(directory, "config.json"), "utf8")).toBe(beforeConflict);
    expect((await readConfig("preview-team")).members).toEqual(beforeMembers);
    await expect(readLogicalWorker("preview-team", "systems"))
      .resolves.toEqual({ kind: "found", worker: { name: "systems", scope: "Team authority" } });
  });

  it("preserves logical Worker meaning but creates a new opaque epoch on explicit Team recreation", async () => {
    const directory = root();
    mockTeamPaths(directory);

    const first = await createTeam("preview-team", "/tmp/lead-a.jsonl", "lead-a");
    await ensureLogicalWorker("preview-team", { name: "product", scope: "Operator value" });
    await deactivateMembership("preview-team", first.members[0].membershipId!, "team_shutdown");

    const second = await createTeam("preview-team", "/tmp/lead-b.jsonl", "lead-b");
    expect(second.epochId).not.toBe(first.epochId);
    expect(second.logicalWorkers).toEqual([{ name: "product", scope: "Operator value" }]);
  });

  it("keeps legacy configs readable and returns typed gaps without mutation", async () => {
    const directory = root();
    mockTeamPaths(directory);
    const configFile = path.join(directory, "config.json");
    const legacy: TeamConfig = {
      name: "preview-team",
      description: "legacy",
      createdAt: 1,
      leadAgentId: "lead",
      leadSessionId: "/tmp/legacy-lead.jsonl",
      members: [{
        membershipId: "legacy-lead",
        agentId: "lead",
        name: "team-lead",
        agentType: "lead",
        joinedAt: 1,
        sessionFile: "/tmp/legacy-lead.jsonl",
        cwd: "/tmp",
        subscriptions: [],
        isActive: true,
      }],
    };
    writeConfigAtomic(configFile, legacy);
    const before = fs.readFileSync(configFile, "utf8");

    await expect(readConfig("preview-team")).resolves.toMatchObject({ description: "legacy" });
    await expect(readLogicalWorker("preview-team", "systems"))
      .resolves.toEqual({ kind: "contract_gap", reason: "team_epoch_missing" });
    await expect(ensureLogicalWorker("preview-team", { name: "systems", scope: "Authority" }))
      .resolves.toEqual({ kind: "contract_gap", reason: "team_epoch_missing" });
    expect(fs.readFileSync(configFile, "utf8")).toBe(before);

    writeConfigAtomic(configFile, { ...legacy, epochId: "team_epoch_legacy-partial" });
    const beforeLogicalWorkerGap = fs.readFileSync(configFile, "utf8");
    await expect(readLogicalWorker("preview-team", "systems"))
      .resolves.toEqual({ kind: "contract_gap", reason: "logical_workers_missing" });
    await expect(ensureLogicalWorker("preview-team", { name: "systems", scope: "Authority" }))
      .resolves.toEqual({ kind: "contract_gap", reason: "logical_workers_missing" });
    expect(fs.readFileSync(configFile, "utf8")).toBe(beforeLogicalWorkerGap);
  });
});

describe("exact lead Session resolution", () => {
  const teamNames: string[] = [];

  beforeEach(() => {
    fs.mkdirSync(paths.TEAMS_DIR, { recursive: true });
  });

  afterEach(() => {
    for (const teamName of teamNames.splice(0)) {
      fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
      fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
    }
  });

  it("resolves one exact current lead and refuses ambiguous bindings", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const first = `preview-lead-a-${suffix}`;
    const second = `preview-lead-b-${suffix}`;
    const session = `/tmp/preview-exact-lead-${suffix}.jsonl`;
    teamNames.push(first, second);

    await createTeam(first, session, "lead-a");
    await expect(resolveCurrentLeadSessionBinding(session)).resolves.toMatchObject({
      status: "bound",
      teamName: first,
      member: { name: "team-lead", sessionFile: session },
    });

    await createTeam(second, session, "lead-b");
    await expect(resolveCurrentLeadSessionBinding(session)).resolves.toEqual({
      status: "abstain",
      reason: "ambiguous_binding",
    });
  });
});
