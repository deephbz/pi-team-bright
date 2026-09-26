// A fresh Node process loads the shipped extension and invokes its registered tools.
// The parent test owns the isolated HOME and the process lifetime.
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir: path.join(process.env.HOME, "vite-cache"),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { optimizeDeps: { noDiscovery: true } },
    appType: "custom",
  });
  globalThis.__dirname = path.join(process.cwd(), "src/task-graph-view");
  globalThis.__filename = path.join(process.cwd(), "extensions/index.ts");
  const piTeams = (await server.ssrLoadModule("/extensions/index.ts")).default;
  const tools = new Map();
  const handlers = new Map();
  piTeams({
    registerTool(tool) { tools.set(tool.name, tool); },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) || []), handler]); },
    sendMessage() {},
    appendEntry() {},
    sendUserMessage() {},
    getActiveTools() { return []; },
    getAllTools() { return []; },
    setActiveTools() {},
  });
  const branch = [...(input.entries || [])];
  const ctx = {
    cwd: input.cwd,
    mode: "tui",
    isIdle() { return false; },
    sessionManager: {
      getSessionId() { return input.sessionFile; },
      getSessionFile() { return input.sessionFile; },
      getBranch() { return branch; },
      buildContextEntries() { return branch; },
      getEntries() { return branch; },
    },
    ui: { notify() {}, setStatus() {}, setFooter() {}, setTitle() {} },
  };
  const results = [];
  for (const call of input.calls) {
    const tool = tools.get(call.name);
    if (!tool) throw new Error(`Public tool ${call.name} was not registered.`);
    for (const handler of handlers.get("tool_call") || []) await handler({ toolName: call.name }, ctx);
    const result = await tool.execute(call.id, call.params, new AbortController().signal, undefined, ctx);
    results.push({ name: call.name, details: result.details, text: result.content?.[0]?.text });
    if (call.ack) {
      const entryId = `persisted-${call.id}`;
      branch.push({
        type: "message",
        id: entryId,
        parentId: branch.at(-1)?.id || null,
        timestamp: new Date().toISOString(),
        message: { role: "toolResult", toolCallId: call.id, content: result.content, isError: false, timestamp: Date.now() },
      });
      for (const handler of handlers.get("before_provider_request") || []) {
        await handler({ payload: { persistedResult: result.content?.[0]?.text } }, ctx);
      }
    }
  }
  process.stdout.write(`FORMAL_RESULT ${JSON.stringify({ pid: process.pid, registered: [...tools.keys()], results, entries: branch })}\n`);
  if (input.hold) setInterval(() => {}, 1000);
  else await server.close();
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
