import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sessionRoot = path.resolve(process.env.PI_TEAMS_SESSION_ROOT || path.join(os.homedir(), ".pi", "agent", "sessions"));
const outputPath = path.resolve(
  process.env.PI_TEAMS_QA_HISTORY_OUTPUT
    || path.join(process.cwd(), "artifacts", "tool-result-qa", "history-catalog.json"),
);

const legacyEnsureWorkerTool = ["worker", "ensure"].join("_");

const currentTools = new Set([
  "team_create", "team_sync", "team_shutdown",
  "ensure_worker", "worker_stop",
  "task_create", "task_read", "task_update", "task_link",
  "alert_send",
]);

const historicalProjection: Record<string, string> = {
  [legacyEnsureWorkerTool]: "ensure_worker",
  spawn_teammate: "ensure_worker",
  teammate_shutdown: "worker_stop",
  send_message: "alert_send",
  broadcast_message: "alert_send",
  task_list: "team_sync",
  check_teammate: "team_sync",
};

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
    }
  }
  return files.sort();
}

function textOf(message: any): string {
  return (message.content || [])
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

function category(tool: string, isError: boolean, text: string, details: any): string {
  if (isError) {
    if (/changed (since version|before claim)|stale|conflict|re-read and retry/i.test(text)) return "error/version-conflict";
    if (/not a current member|not the current binding|fork\/stale Session/i.test(text)) return "error/stale-identity";
    if (/does not exist|not found/i.test(text)) return "error/not-found";
    if (/legacy JSON Task authority|migrate:tasks/i.test(text)) return "error/legacy-authority";
    if (/nonterminal Tasks|Cannot stop Worker/i.test(text)) return "error/lifecycle-guard";
    if (/claim.*cannot be combined|one atomic backend mutation|one atomic ownership operation|partial multi-command/i.test(text)) return "error/invalid-composition";
    if (/already claimed|not claimable/i.test(text)) return "error/claim-rejected";
    if (/Validation failed|Invalid name|allowed values/i.test(text)) return "error/invalid-input";
    if (/recipient .* not a current member/i.test(text)) return "error/recipient-stale";
    if (/Beads command failed/i.test(text)) return "error/backend";
    return "error/other";
  }
  if (tool === "ensure_worker") return /reused/i.test(text) ? "success/reused" : "success/created";
  if (tool === "team_sync") {
    if (details?.timedOut) return "success/timeout";
    if (Array.isArray(details?.events) && details.events.length > 1) return "success/multiple-events";
    if (Array.isArray(details?.events) && details.events.length === 1) return "success/one-event";
    return "success/snapshot";
  }
  if (tool === "team_shutdown") return /partial|failure/i.test(text) || details?.failures?.length ? "success/partial" : "success/complete";
  if (tool === "alert_send") return details?.failures?.length ? "success/partial" : "success/accepted";
  if (tool === "task_update") return `success/${details?.task?.status || "updated"}`;
  if (tool === "task_link") return "success/relation-mutated";
  if (tool === "task_read") return text.length > 2_000 ? "success/large-read" : "success/read";
  if (tool === "task_create") return details?.task?.assignee ? "success/assigned" : "success/unassigned";
  if (tool === "worker_stop") return "success/stopped";
  if (tool === "team_create") return "success/created";
  return "success/other";
}

function main() {
  const evidence: any[] = [];
  const files = filesUnder(sessionRoot);
  const seenToolResults = new Set<string>();
  let matchingObservations = 0;
  let forkDuplicatesIgnored = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = entry?.type === "message" ? entry.message : undefined;
      if (message?.role !== "toolResult" || typeof message.toolName !== "string") continue;
      const projectedTool = currentTools.has(message.toolName) ? message.toolName : historicalProjection[message.toolName];
      if (!projectedTool) continue;
      matchingObservations += 1;
      const identity = message.toolCallId
        ? `${message.toolName}\u0000call:${message.toolCallId}`
        : `${message.toolName}\u0000entry:${entry.id || `${path.relative(sessionRoot, file)}:${index + 1}`}`;
      if (seenToolResults.has(identity)) {
        forkDuplicatesIgnored += 1;
        continue;
      }
      seenToolResults.add(identity);
      const text = textOf(message);
      const detailsText = JSON.stringify(message.details || {});
      evidence.push({
        projectedTool,
        originalTool: message.toolName,
        category: category(projectedTool, !!message.isError, text, message.details),
        isError: !!message.isError,
        agentCharacters: text.length,
        machineCharacters: detailsText.length,
        source: {
          session: path.relative(sessionRoot, file),
          entryId: entry.id,
          line: index + 1,
          timestamp: entry.timestamp || message.timestamp,
          toolCallId: message.toolCallId,
        },
      });
    }
  }

  const grouped = new Map<string, any[]>();
  for (const item of evidence) {
    const key = `${item.projectedTool}\u0000${item.category}`;
    const items = grouped.get(key) || [];
    items.push(item);
    grouped.set(key, items);
  }
  const scenarios = [...grouped.values()].map((items) => {
    const sorted = [...items].sort((a, b) => a.agentCharacters - b.agentCharacters);
    return {
      currentTool: items[0].projectedTool,
      category: items[0].category,
      observations: items.length,
      originalTools: [...new Set(items.map((item) => item.originalTool))].sort(),
      agentCharacters: {
        min: sorted[0].agentCharacters,
        median: sorted[Math.floor(sorted.length / 2)].agentCharacters,
        max: sorted.at(-1).agentCharacters,
      },
      machineCharacters: {
        min: Math.min(...items.map((item) => item.machineCharacters)),
        max: Math.max(...items.map((item) => item.machineCharacters)),
      },
    };
  }).sort((a, b) => a.currentTool.localeCompare(b.currentTool) || a.category.localeCompare(b.category));

  const byCurrentTool = Object.fromEntries(
    [...currentTools]
      .sort()
      .map((tool) => [tool, evidence.filter((item) => item.projectedTool === tool).length]),
  );
  const byCategory = Object.fromEntries(
    [...new Set(evidence.map((item) => item.category))]
      .sort()
      .map((itemCategory) => [itemCategory, evidence.filter((item) => item.category === itemCategory).length]),
  );

  const record = {
    schema: "pi-teams-historical-tool-scenario-catalog/3",
    generatedAt: new Date().toISOString(),
    source: {
      kind: "local-pi-session-history",
      sessionFiles: files.length,
      privacy: "Only aggregate tool, category, count, and size projections are emitted. Local coordinates and content remain in source JSONL.",
      deduplication: "Tool-call and entry identities are used transiently for fork deduplication and are never serialized.",
    },
    projectionRule: {
      currentTools: [...currentTools].sort(),
      historicalProjection,
    },
    observationCounts: {
      matching: matchingObservations,
      unique: evidence.length,
      forkDuplicatesIgnored,
    },
    summary: {
      scenarios: scenarios.length,
      byCurrentTool,
      byCategory,
    },
    scenarios,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`Historical QA catalog: ${outputPath}\n${JSON.stringify(record.observationCounts, null, 2)}\n${JSON.stringify(record.summary, null, 2)}\n`);
}

main();
