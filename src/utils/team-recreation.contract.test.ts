import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, taskDir, teamDir } from "./paths";
import { createTeam, deactivateMembership, readConfig } from "./teams";

const created: string[] = [];

function uniqueTeam(suffix: string): string {
  const name = `recreation-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  created.push(name);
  return name;
}

afterEach(() => {
  for (const name of created.splice(0)) {
    fs.rmSync(teamDir(name), { recursive: true, force: true });
    fs.rmSync(taskDir(name), { recursive: true, force: true });
  }
});

describe("clean-cut Team recreation", () => {
  it("serializes two process-synchronized creators so exactly one lead generation wins", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-create-race-home-"));
    const name = `create-race-${process.pid}-${Date.now()}`;
    const teamsModule = path.resolve("src/utils/teams.ts");
    const childSource = `
      const { createTeam } = require(${JSON.stringify(teamsModule)});
      process.stdout.write("READY\\n");
      process.stdin.once("data", async () => {
        try {
          const config = await createTeam(process.argv[1], process.argv[2], process.argv[3]);
          process.stdout.write(JSON.stringify({ status: "success", sessionFile: config.members[0].sessionFile }) + "\\n");
          process.exit(0);
        } catch (error) {
          process.stdout.write(JSON.stringify({ status: "rejected", error: String(error) }) + "\\n");
          process.exit(0);
        }
      });
    `;

    const launch = (sessionFile: string, leadAgentId: string) => {
      const child = spawn(process.execPath, [
        "-r",
        "ts-node/register/transpile-only",
        "-e",
        childSource,
        name,
        sessionFile,
        leadAgentId,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdio: ["pipe", "pipe", "inherit"],
      });
      let output = "";
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("READY\n")) readyResolve();
      });
      const result = new Promise<{ status: string; sessionFile?: string; error?: string }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== 0) return reject(new Error(`creator child exited ${code}: ${output}`));
          const line = output.trim().split("\n").find((item) => item.startsWith("{"));
          if (!line) return reject(new Error(`creator child produced no result: ${output}`));
          resolve(JSON.parse(line));
        });
      });
      return { child, ready, result };
    };

    try {
      const first = launch("/tmp/race-a.jsonl", "lead-a");
      const second = launch("/tmp/race-b.jsonl", "lead-b");
      await Promise.all([first.ready, second.ready]);
      first.child.stdin.write("start");
      second.child.stdin.write("start");
      const results = await Promise.all([first.result, second.result]);
      const successes = results.filter((result) => result.status === "success");
      const rejections = results.filter((result) => result.status === "rejected");
      const persisted = JSON.parse(fs.readFileSync(path.join(home, ".pi", "teams", name, "config.json"), "utf8"));
      const current = persisted.members.filter((member: { isActive?: boolean }) => member.isActive !== false);

      expect(successes).toHaveLength(1);
      expect(rejections).toHaveLength(1);
      expect(rejections[0].error).toMatch(/current Memberships.*team_shutdown/i);
      expect(current).toHaveLength(1);
      expect(current[0].sessionFile).toBe(successes[0].sessionFile);
      expect(persisted.members).toHaveLength(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects recreation while any Membership is current without changing TeamConfig", async () => {
    const name = uniqueTeam("current");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-recreation-beads-"));
    const fingerprint = { schema: "pi-teams-beads-authority/1" as const, backend: "dolt" as const, database: "dolt" as const, doltDatabase: "recreation_current", projectId: "recreation-current" };
    const first = await createTeam(name, "/tmp/lead-old.jsonl", "lead-old", "old", undefined, undefined, workspace, "authority-stable", fingerprint);
    const before = fs.readFileSync(configPath(name), "utf8");

    await expect(createTeam(name, "/tmp/lead-new.jsonl", "lead-new", "new", undefined, undefined, workspace, "authority-stable", fingerprint))
      .rejects.toThrow(/current Memberships.*team_shutdown.*never implicitly stops processes or replaces live identities/i);

    expect(fs.readFileSync(configPath(name), "utf8")).toBe(before);
    expect(first.members.find((member) => member.name === "team-lead")?.isActive).toBe(true);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("recreates only after explicit closure and preserves history plus Beads authority", async () => {
    const name = uniqueTeam("closed");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-recreation-beads-"));
    const fingerprint = { schema: "pi-teams-beads-authority/1" as const, backend: "dolt" as const, database: "dolt" as const, doltDatabase: "recreation_closed", projectId: "recreation-closed" };
    const first = await createTeam(name, "/tmp/lead-old.jsonl", "lead-old", "old", undefined, undefined, workspace, "authority-stable", fingerprint);
    const oldLead = first.members.find((member) => member.name === "team-lead")!;
    await deactivateMembership(name, oldLead.membershipId!, "team_shutdown");

    const recreated = await createTeam(name, "/tmp/lead-new.jsonl", "lead-new", "new", undefined, undefined, workspace, "authority-stable", fingerprint);
    const persisted = await readConfig(name);
    const historical = persisted.members.find((member) => member.membershipId === oldLead.membershipId);
    const current = persisted.members.filter((member) => member.isActive !== false);

    expect(recreated.taskBackend).toBe("beads");
    expect(recreated.taskWorkspace).toBe(workspace);
    expect(recreated.taskAuthorityId).toBe("authority-stable");
    expect(historical).toMatchObject({ isActive: false, deactivationReason: "team_shutdown" });
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ name: "team-lead", sessionFile: "/tmp/lead-new.jsonl" });
    expect(current[0].membershipId).not.toBe(oldLead.membershipId);
    fs.rmSync(workspace, { recursive: true, force: true });
  });
});
