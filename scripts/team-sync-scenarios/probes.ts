// Scenario-only extension. It injects proof loss and exercises historical rendering.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createToolResultRenderer } from "../../src/model-tool-contract/tui-projection";

export default function probes(pi: ExtensionAPI) {
  pi.registerTool({
    name: "scenario_sequential", label: "Scenario sequential gate", description: "Force Pi sequential execution for this message.",
    executionMode: "sequential", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: '{"kind":"gate"}' }], details: { kind: "gate" } }; },
  });
  if (process.env.PI_SCENARIO_DROP_SYNC === "1") {
    let removedCallId: string | undefined;
    pi.on("context", (event) => {
      removedCallId ??= event.messages.find((message) => message.role === "toolResult" && message.toolName === "team_sync")?.toolCallId;
      return { messages: event.messages.map((message) => message.role === "toolResult" && message.toolCallId === removedCallId
        ? { ...message, content: [{ type: "text" as const, text: "Scenario removed observation before provider proof." }] }
        : message) };
    });
  }
  pi.registerCommand("scenario-history", {
    description: "Append and render a historical team_sync entry.",
    handler: async (_args, ctx) => {
      const result = { kind: "indeterminate", message: "Historical observation evidence was incomplete." };
      const details = { ...result, state_changed: false, observation_advanced: false };
      const text = JSON.stringify(result);
      const toolCallId = "historical-team-sync";
      ctx.sessionManager.appendMessage({
        role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "team_sync", arguments: { view: "updates" } }],
        api: "openai-completions", provider: "fixture", model: "scripted", stopReason: "toolUse", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      const content = [{ type: "text" as const, text }];
      ctx.sessionManager.appendMessage({ role: "toolResult", toolCallId, toolName: "team_sync", content, details, isError: false, timestamp: Date.now() });
      const theme = { fg: (_role: string, value: string) => value, bg: (_role: string, value: string) => value, bold: (value: string) => value };
      const renderer = createToolResultRenderer("team_sync");
      const collapsed = renderer({ content, details }, { expanded: false, isPartial: false }, theme as any, {} as any).render(100);
      const expanded = renderer({ content, details }, { expanded: true, isPartial: false }, theme as any, {} as any).render(100);
      pi.appendEntry("scenario-history-render", { text, collapsed, expanded });
    },
  });
}
