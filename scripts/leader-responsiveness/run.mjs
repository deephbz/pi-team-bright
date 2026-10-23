#!/usr/bin/env node
// Reuse the real-Pi scenario suite's loopback provider. No remote model calls.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LocalProviderFixture, toolCallResponse, textResponse } from "../team-sync-continuity-e2e/harness.mjs";
const provider = await new LocalProviderFixture().start();
let sequence = 0;
const poll = setInterval(() => {
  for (const request of provider.requests.filter(r => r.sequence > sequence)) {
    sequence = request.sequence;
    const last = request.body.messages.at(-1);
    if (last?.role === "user") {
      const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      const mode = text.match(/RUN_(async|block|coordination)/)?.[1];
      provider.answer(request, mode ? toolCallResponse("responsiveness_probe", { mode }) : textResponse("Ready"));
    } else provider.answer(request, textResponse("Done"));
  }
}, 5);
try {
  const child = spawn("python3", [fileURLToPath(new URL("./run.py", import.meta.url)), "--provider", provider.baseUrl, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exitCode = await new Promise(resolve => child.on("exit", code => resolve(code ?? 1)));
} finally { clearInterval(poll); await provider.close(); }
