import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const repo = path.resolve(process.env.SNAPSHOT_REPO || process.cwd());
const output = path.resolve(process.env.SNAPSHOT_OUTPUT || path.join(process.cwd(), "agent-surface.json"));
const label = process.env.SNAPSHOT_LABEL || path.basename(repo);
const revision = process.env.SNAPSHOT_REVISION || "working-tree";

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

test("captures the agent-facing PiTeams surface", async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-surface-"));
  const previous = {
    HOME: process.env.HOME,
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
    PI_TEAM_NAME: process.env.PI_TEAM_NAME,
    PI_AGENT_NAME: process.env.PI_AGENT_NAME,
    PI_AGENT_LAUNCH_ID: process.env.PI_AGENT_LAUNCH_ID
  };
  process.env.HOME = fakeHome;
  process.env.TMUX = "";
  delete process.env.TMUX_PANE;
  delete process.env.PI_AGENT_LAUNCH_ID;

  const teamName = "surface-snapshot";
  const workerSession = path.join(fakeHome, "worker.jsonl");
  const teamDir = path.join(fakeHome, ".pi", "teams", teamName);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(path.join(teamDir, "config.json"), JSON.stringify({
    name: teamName,
    description: "Agent-facing surface snapshot fixture",
    createdAt: 0,
    leadAgentId: "lead-agent",
    leadSessionId: "lead-session",
    members: [
      {
        membershipId: "membership_lead",
        agentId: "lead-agent",
        name: "team-lead",
        agentType: "lead",
        joinedAt: 0,
        tmuxPaneId: "",
        sessionFile: path.join(fakeHome, "lead.jsonl"),
        cwd: repo,
        subscriptions: [],
        isActive: true
      },
      {
        membershipId: "membership_worker",
        agentId: `worker@${teamName}`,
        name: "worker",
        agentType: "teammate",
        model: "example-provider/example-model",
        thinking: "medium",
        joinedAt: 0,
        tmuxPaneId: "",
        sessionFile: workerSession,
        cwd: repo,
        subscriptions: [],
        prompt: "Review coordination semantics and report evidence.",
        isActive: true
      }
    ]
  }, null, 2));

  try {
    const extension = (await import(/* @vite-ignore */ `${pathToFileURL(path.join(repo, "extensions", "index.ts")).href}?snapshot=${Date.now()}`)).default;

    function instantiate(role: "lead" | "worker") {
      process.env.PI_TEAM_NAME = teamName;
      if (role === "worker") process.env.PI_AGENT_NAME = "worker";
      else delete process.env.PI_AGENT_NAME;

      const tools: any[] = [];
      const handlers = new Map<string, (...args: any[]) => any>();
      extension({
        registerTool(tool: any) {
          tools.push({
            name: tool.name,
            description: tool.description,
            parameters: canonical(tool.parameters)
          });
        },
        on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
        sendMessage() {},
        appendEntry() {},
        sendUserMessage() {}
      } as any);
      return { tools, handlers };
    }

    async function promptsFor(role: "lead" | "worker") {
      const { handlers } = instantiate(role);
      const base = "BASE_SYSTEM_PROMPT";
      const ctx = {
        sessionManager: {
          getSessionFile: () => role === "worker" ? workerSession : path.join(fakeHome, "lead.jsonl"),
          buildContextEntries: () => [],
          getEntries: () => []
        },
        ui: { setStatus() {}, notify() {}, setTitle() {} }
      };
      const capture = async () => {
        const result = await handlers.get("before_agent_start")?.({ systemPrompt: base }, ctx);
        const full = result?.systemPrompt || base;
        return {
          full,
          extensionDelta: full.startsWith(base) ? full.slice(base.length) : full
        };
      };
      return { firstTurn: await capture(), steadyState: await capture() };
    }

    const lead = instantiate("lead");
    const extensionPath = path.join(repo, "extensions", "index.ts");
    const skillPath = path.join(repo, "skills", "pi-teams", "SKILL.md");
    const snapshot = {
      schema: "pi-teams-agent-surface-snapshot/1",
      label,
      source: {
        revision,
        extension: "extensions/index.ts",
        extensionSha256: crypto.createHash("sha256").update(fs.readFileSync(extensionPath)).digest("hex"),
        skill: "skills/pi-teams/SKILL.md",
        skillSha256: crypto.createHash("sha256").update(fs.readFileSync(skillPath)).digest("hex")
      },
      prompts: { lead: await promptsFor("lead"), worker: await promptsFor("worker") },
      tools: lead.tools,
      skill: fs.readFileSync(skillPath, "utf8")
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
    expect(snapshot.tools.length).toBeGreaterThan(0);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
