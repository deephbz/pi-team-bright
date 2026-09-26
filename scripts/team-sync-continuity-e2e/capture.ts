import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const captureFile = process.env.PI_TEAM_SYNC_CONTEXT_CAPTURE;

export default function captureFrameworkContext(pi: ExtensionAPI): void {
  if (!captureFile) return;
  pi.on("context", (event) => {
    const messages = event.messages as unknown as Array<Record<string, any>>;
    const frameworkCalls = messages.filter((message) => message.role === "assistant" && message.provider === "pi-team-bright-framework").map((message) => ({
      role: message.role,
      provider: message.provider,
      model: message.model,
      usage: message.usage,
      toolCalls: Array.isArray(message.content) ? message.content.filter((part) => part?.type === "toolCall").map((part) => ({ id: part.id, name: part.name, arguments: part.arguments })) : [],
    }));
    const toolResults = messages.filter((message) => message.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId.startsWith("framework-team-sync-")).map((message) => ({
      role: message.role,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
    }));
    if (frameworkCalls.length || toolResults.length) fs.appendFileSync(captureFile, `${JSON.stringify({ frameworkCalls, toolResults })}\n`);
  });
}
