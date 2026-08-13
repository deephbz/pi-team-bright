import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

const EXPECTED_TOOL_NAMES = [
  "team_create",
  "team_sync",
  "ensure_worker",
  "task_graph_apply",
  "task_read",
  "task_update",
  "worker_stop",
  "team_shutdown",
  "alert_send",
] as const;

const MAX_COMPACT_CHARACTERS = {
  team_create: 660,
  team_sync: 380,
  ensure_worker: 440,
  task_graph_apply: 1_500,
  task_read: 360,
  task_update: 1_200,
  worker_stop: 330,
  team_shutdown: 250,
  alert_send: 740,
} as const;

function compact(value: unknown): string {
  return JSON.stringify(value);
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z_]+/g) ?? []);
}

function overlap(left: string, right: string): number {
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter(word => b.has(word)).length;
  return shared / Math.min(a.size, b.size);
}

/** Provider framing and tokenizers vary; compact characters are the stable CI budget authority. */
test("keeps the registered model-tool grammar compact and non-duplicative", { timeout: 30_000 }, async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-tool-budget-"));
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const extension = (await import("../extensions/index.ts")).default;
    const tools: Array<{ name: string; description: string; parameters: any }> = [];
    extension({
      registerTool(tool: any) {
        tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
      },
      on() {},
      sendMessage() {},
      appendEntry() {},
      sendUserMessage() {},
    } as any);

    expect(tools.map(tool => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    for (const tool of tools) {
      const budget = MAX_COMPACT_CHARACTERS[tool.name as keyof typeof MAX_COMPACT_CHARACTERS];
      expect(compact(tool).length, `${tool.name} compact provider schema budget`).toBeLessThanOrEqual(budget);
      const rootDescription = tool.parameters?.description;
      if (typeof rootDescription === "string") {
        expect(overlap(tool.description, rootDescription), `${tool.name} repeats its tool description in the root schema`).toBeLessThan(0.6);
      }
    }

    const byName = new Map(tools.map(tool => [tool.name, tool]));
    const graphApply = byName.get("task_graph_apply")!;
    expect(graphApply.parameters.properties.tasks.items.properties).toHaveProperty("needs");
    expect(graphApply.parameters.properties).not.toHaveProperty("dependencies");
    expect(compact(graphApply.parameters)).not.toContain('"anyOf"');

    const alert = byName.get("alert_send")!;
    expect(alert.parameters).toMatchObject({ type: "object", required: ["to", "kind", "text"], additionalProperties: false });
    expect(compact(alert.parameters)).not.toContain('"anyOf"');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
