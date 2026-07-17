import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import { BeadsTaskStore, readBeadsAuthorityFingerprint } from "./beads";
import type { TeamConfig } from "./models";
import * as paths from "./paths";
import { BEADS_WORKSPACE_ENV } from "./tasks";
import * as teams from "./teams";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: any,
  ) => Promise<any>;
};

type Handler = (event: any, ctx: any) => Promise<any>;

const hasBd = spawnSync("bd", ["--version"], { stdio: "ignore" }).status === 0;
const createdTeams: string[] = [];
const createdRoots: string[] = [];
const activeHarnesses: Array<{ handlers: Map<string, Handler>; ctx: ReturnType<typeof context> }> = [];

// These contracts exercise real, fsync-backed Beads authorities.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function uniqueTeam(suffix: string): string {
  const name = `team-owned-${suffix}-${process.pid}-${Date.now()}-${createdTeams.length}`;
  createdTeams.push(name);
  return name;
}

function context(sessionFile: string) {
  return {
    isIdle: vi.fn(() => false),
    sessionManager: {
      getSessionFile: vi.fn(() => sessionFile),
      buildContextEntries: vi.fn(() => []),
    },
    ui: { setStatus: vi.fn(), notify: vi.fn(), setTitle: vi.fn() },
  };
}

function harness() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler>();
  piTeams({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    sendMessage() {},
    appendEntry() {},
    sendUserMessage() {},
  } as never);
  return { tools, handlers };
}

function initBeadsWorkspace(workspace?: string): string {
  const root = workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-explicit-beads-"));
  if (!workspace) createdRoots.push(root);
  fs.mkdirSync(root, { recursive: true });
  execFileSync("bd", ["init", "--quiet", "--skip-agents", "--skip-hooks", "--non-interactive"], {
    cwd: root,
    stdio: "ignore",
  });
  return root;
}

function readPersistedConfig(teamName: string): TeamConfig {
  return JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf8")) as TeamConfig;
}

async function createWithTools(teamName: string, sessionFile = `/tmp/${teamName}-lead.jsonl`) {
  const { tools, handlers } = harness();
  const ctx = context(sessionFile);
  const result = await tools.get("team_create")!.execute(
    "create",
    { team_name: teamName },
    undefined,
    undefined,
    ctx,
  );
  activeHarnesses.push({ handlers, ctx });
  expect(result.details).toMatchObject({
    schema: "pi-teams-tool-result/1",
    outcome: "accepted",
    operation: "team_create",
    resource: { kind: "team", id: teamName, teamName },
    postState: { name: teamName, lifecycle: "active", taskAuthorityReady: true },
    evidence: { taskAuthority: { backend: "beads" } },
  });
  return { tools, ctx, config: readPersistedConfig(teamName) };
}

afterEach(async () => {
  for (const { handlers, ctx } of activeHarnesses.splice(0)) {
    await handlers.get("session_shutdown")?.({ reason: "test-cleanup" }, ctx);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const teamName of createdTeams.splice(0)) {
    fs.rmSync(paths.teamDir(teamName), { recursive: true, force: true });
    fs.rmSync(paths.taskDir(teamName), { recursive: true, force: true });
  }
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!hasBd)("team-owned Beads Task authority", () => {
  it("creates a private authority in the Team directory by default and can create a Task immediately", async () => {
    vi.stubEnv(BEADS_WORKSPACE_ENV, "");
    const teamName = uniqueTeam("default");
    const sessionFile = `/tmp/${teamName}-lead.jsonl`;

    const { tools, ctx, config } = await createWithTools(teamName, sessionFile);
    const expectedWorkspace = paths.teamDir(teamName);
    const persisted = readPersistedConfig(teamName);

    expect(config).toMatchObject({
      taskBackend: "beads",
      taskWorkspace: expectedWorkspace,
    });
    expect(config.taskAuthorityId).toMatch(/^task_authority_[0-9a-f-]+$/);
    expect(config.taskAuthorityFingerprint).toEqual(readBeadsAuthorityFingerprint(expectedWorkspace));
    expect(persisted).toMatchObject({
      taskBackend: "beads",
      taskWorkspace: expectedWorkspace,
      taskAuthorityId: config.taskAuthorityId,
      taskAuthorityFingerprint: config.taskAuthorityFingerprint,
    });
    expect(fs.statSync(path.join(expectedWorkspace, ".beads", "metadata.json")).isFile()).toBe(true);
    expect(fs.existsSync(paths.taskDir(teamName))).toBe(false);

    const created = await tools.get("task_create")!.execute(
      "create-task",
      {
        team_name: teamName,
        title: "Use the default private authority",
        description: "The first Task must work without operator setup.",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(created.details).toMatchObject({
      schema: "pi-teams-tool-result/1",
      outcome: "accepted",
      operation: "task_create",
      postState: {
        title: "Use the default private authority",
        description: "The first Task must work without operator setup.",
      },
    });
    const createdTaskId = created.details.postState.id as string;

    const restartedStore = new BeadsTaskStore({
      teamName,
      workspace: expectedWorkspace,
      authorityFingerprint: config.taskAuthorityFingerprint,
      requireExpectedVersion: false,
    });
    await expect(restartedStore.read(createdTaskId)).resolves.toMatchObject({
      id: createdTaskId,
      title: "Use the default private authority",
    });
  });

  it("uses a valid explicit override but never falls back from an invalid override", async () => {
    const override = initBeadsWorkspace();
    vi.stubEnv(BEADS_WORKSPACE_ENV, override);
    const explicitTeam = uniqueTeam("explicit");

    const { config } = await createWithTools(explicitTeam);
    expect(config.taskWorkspace).toBe(override);
    expect(config.taskAuthorityFingerprint).toEqual(readBeadsAuthorityFingerprint(override));
    expect(fs.existsSync(path.join(paths.teamDir(explicitTeam), ".beads"))).toBe(false);

    const invalidOverride = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-invalid-override-"));
    createdRoots.push(invalidOverride);
    vi.stubEnv(BEADS_WORKSPACE_ENV, invalidOverride);
    const rejectedTeam = uniqueTeam("invalid-explicit");

    await expect(createWithTools(rejectedTeam)).rejects.toThrow(/initialized authority root|Beads workspace/i);
    expect(fs.existsSync(paths.configPath(rejectedTeam))).toBe(false);
    expect(fs.existsSync(path.join(paths.teamDir(rejectedTeam), ".beads"))).toBe(false);
  });

  it("reuses the exact persisted authority on Team recreation instead of switching to a new override", async () => {
    vi.stubEnv(BEADS_WORKSPACE_ENV, "");
    const teamName = uniqueTeam("recreate");
    const first = await createWithTools(teamName, `/tmp/${teamName}-first.jsonl`);
    const firstLead = first.config.members.find(member => member.name === "team-lead" && member.isActive !== false)!;
    await teams.deactivateMembership(teamName, firstLead.membershipId!, "team_shutdown");

    const conflictingOverride = initBeadsWorkspace();
    vi.stubEnv(BEADS_WORKSPACE_ENV, conflictingOverride);
    const recreated = await createWithTools(teamName, `/tmp/${teamName}-second.jsonl`);

    expect(recreated.config.taskWorkspace).toBe(paths.teamDir(teamName));
    expect(recreated.config.taskWorkspace).not.toBe(conflictingOverride);
    expect(recreated.config.taskAuthorityId).toBe(first.config.taskAuthorityId);
    expect(recreated.config.taskAuthorityFingerprint).toEqual(first.config.taskAuthorityFingerprint);
    expect(readPersistedConfig(teamName)).toMatchObject({
      taskWorkspace: paths.teamDir(teamName),
      taskAuthorityId: first.config.taskAuthorityId,
      taskAuthorityFingerprint: first.config.taskAuthorityFingerprint,
    });
  });

  it("recovers an initialized default authority left before config persistence without reinitializing it", async () => {
    vi.stubEnv(BEADS_WORKSPACE_ENV, "");
    const teamName = uniqueTeam("orphan-initialized");
    const workspace = paths.teamDir(teamName);
    initBeadsWorkspace(workspace);
    const before = readBeadsAuthorityFingerprint(workspace);

    const { config } = await createWithTools(teamName);

    expect(config.taskWorkspace).toBe(workspace);
    expect(config.taskAuthorityFingerprint).toEqual(before);
    expect(readBeadsAuthorityFingerprint(workspace)).toEqual(before);
  });

  it("repairs an incomplete default workspace non-destructively", async () => {
    vi.stubEnv(BEADS_WORKSPACE_ENV, "");
    const teamName = uniqueTeam("partial-beads");
    const markerDir = path.join(paths.teamDir(teamName), ".beads");
    fs.mkdirSync(markerDir, { recursive: true });
    const sentinel = path.join(markerDir, "operator-data");
    fs.writeFileSync(sentinel, "preserve me");

    const { config } = await createWithTools(teamName);

    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve me");
    expect(config.taskWorkspace).toBe(paths.teamDir(teamName));
    expect(config.taskAuthorityFingerprint).toEqual(readBeadsAuthorityFingerprint(paths.teamDir(teamName)));
  });

  it("preserves malformed authority metadata and fails closed instead of reinitializing it", async () => {
    vi.stubEnv(BEADS_WORKSPACE_ENV, "");
    const teamName = uniqueTeam("malformed-metadata");
    const metadataPath = path.join(paths.teamDir(teamName), ".beads", "metadata.json");
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, "not-json");

    await expect(createWithTools(teamName)).rejects.toThrow(/unreadable authority metadata|not initialized/i);

    expect(fs.readFileSync(metadataPath, "utf8")).toBe("not-json");
    expect(fs.existsSync(paths.configPath(teamName))).toBe(false);
  });

  it("fails closed when persisted authority identity is incomplete or its database was replaced", async () => {
    vi.stubEnv(BEADS_WORKSPACE_ENV, "");
    const incompleteTeam = uniqueTeam("incomplete-config");
    const first = await createWithTools(incompleteTeam);
    const firstLead = first.config.members.find(member => member.name === "team-lead" && member.isActive !== false)!;
    await teams.deactivateMembership(incompleteTeam, firstLead.membershipId!, "team_shutdown");
    const incomplete = readPersistedConfig(incompleteTeam);
    delete incomplete.taskAuthorityId;
    fs.writeFileSync(paths.configPath(incompleteTeam), JSON.stringify(incomplete, null, 2));
    const incompleteBefore = fs.readFileSync(paths.configPath(incompleteTeam), "utf8");

    await expect(createWithTools(incompleteTeam, `/tmp/${incompleteTeam}-replacement.jsonl`))
      .rejects.toThrow(/incomplete Beads Task authority binding/i);
    expect(fs.readFileSync(paths.configPath(incompleteTeam), "utf8")).toBe(incompleteBefore);

    const replacedTeam = uniqueTeam("replaced-database");
    const original = await createWithTools(replacedTeam);
    const originalLead = original.config.members.find(member => member.name === "team-lead" && member.isActive !== false)!;
    await teams.deactivateMembership(replacedTeam, originalLead.membershipId!, "team_shutdown");
    const workspace = paths.teamDir(replacedTeam);
    const replacement = initBeadsWorkspace();
    fs.renameSync(path.join(workspace, ".beads"), path.join(workspace, ".beads-original"));
    fs.renameSync(path.join(replacement, ".beads"), path.join(workspace, ".beads"));
    const configBefore = fs.readFileSync(paths.configPath(replacedTeam), "utf8");

    await expect(createWithTools(replacedTeam, `/tmp/${replacedTeam}-replacement.jsonl`))
      .rejects.toThrow(/fingerprint mismatch|different database/i);
    expect(fs.readFileSync(paths.configPath(replacedTeam), "utf8")).toBe(configBefore);
    expect(readPersistedConfig(replacedTeam).taskAuthorityFingerprint).toEqual(original.config.taskAuthorityFingerprint);
  });
});
