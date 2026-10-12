import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { incidentNames, reconstruct, type Extraction, type TeamInput } from "./reconstruct";

// This adapter imports no PTB store code: store readers can migrate or repair state.
// Only this file has filesystem effects. All writes stay in the fixed external corpus.
type Row = Record<string, any>;
interface ReadStats { files: number; missing: number; malformed: number; missingSessions: number; teams: number }
function files(root: string, extension: string): string[] {
  const result: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return result; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) result.push(...files(path.join(root, e.name), extension));
    else if (e.isFile() && e.name.endsWith(extension)) result.push(path.join(root, e.name));
  }
  return result;
}
function object(x: unknown): x is Row { return !!x && typeof x === "object" && !Array.isArray(x); }

/** Reject repositories and symlink redirection before creating any output. */
export function assertExternalDirectory(target: string): void {
  let current = path.resolve(target);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) throw new Error("Corpus must remain outside repositories");
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe corpus directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function writeExternal(root: string, name: string, content: string): void {
  assertExternalDirectory(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, name);
  // Exclusive temporary creation plus rename avoids following destination symlinks.
  const temporary = path.join(root, `.extract-${randomBytes(12).toString("hex")}`);
  fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function extractCorpus(): { traces: number; incidents: Extraction["incidents"]; stats: ReadStats } {
  const home = os.homedir();
  const teams = path.join(home, ".pi", "teams");
  const output = path.join(home, ".pi", "ptb-sim-corpus");
  assertExternalDirectory(output);
  // Filenames index Session ids; only referenced files are opened.
  const sessionIndex = new Map<string, string[]>();
  for (const file of files(path.join(home, ".pi", "agent", "sessions"), ".jsonl")) {
    const name = path.basename(file, ".jsonl");
    const id = name.slice(name.indexOf("_") + 1);
    sessionIndex.set(id, [...(sessionIndex.get(id) ?? []), file]);
  }
  const stats: ReadStats = { files: 0, missing: 0, malformed: 0, missingSessions: 0, teams: 0 };
  const aggregate = Object.fromEntries(incidentNames.map(k => [k, { observed: 0, candidate: 0 }])) as Extraction["incidents"];
  const kinds: Record<string, number> = Object.fromEntries([
    "pi.start", "tool.call", "turn.end", "agent.settled", "human.escape", "human.interrupt",
    "human.closePane", "human.typeInPane", "pi.shutdown", "pi.compact", "pi.tree", "pi.fork", "pi.newSession",
    "os.kill", "os.pidReuse", "os.reboot", "herdr.agentState", "herdr.restart", "fault.set", "fault.clear",
  ].map(k => [k, 0]));
  const coverage = { sessionRows: 0, eventRows: 0, runtimeRows: 0, taskSnapshots: 0, duplicateEntries: 0, untimedRows: 0 };
  const manifest: { id: string; steps: number; provenance: string }[] = [];
  const toolActors = { lead: 0, worker: 0 };
  let clockGaps = 0;
  // A run directory prevents stale traces from being counted as current output.
  const run = `run-${randomBytes(8).toString("hex")}`;
  const runDirectory = path.join(output, run);
  const teamDirectories = fs.readdirSync(teams, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of teamDirectories) {
    const directory = path.join(teams, entry.name);
    if (!fs.existsSync(path.join(directory, "config.json"))) continue;
    const digest = createHash("sha256");
    const read = (file: string, jsonl = false): Row[] => {
      let bytes: Buffer;
      try { bytes = fs.readFileSync(file); } catch { stats.missing++; return []; }
      stats.files++;
      digest.update(String(bytes.length)).update(":").update(bytes);
      const rows: Row[] = [];
      for (const text of jsonl ? bytes.toString("utf8").split("\n") : [bytes.toString("utf8")]) {
        if (!text.trim()) continue;
        try {
          const value: unknown = JSON.parse(text);
          if (object(value)) rows.push(value); else stats.malformed++;
        } catch { stats.malformed++; }
      }
      return rows;
    };
    const config = read(path.join(directory, "config.json"))[0];
    if (!config) continue;
    stats.teams++;
    const lead = read(path.join(directory, "lead-session.json"))[0];
    const events = read(path.join(directory, "events", "team-events.jsonl"), true);
    const runtime = files(path.join(directory, "runtime"), ".json").flatMap(file => read(file));
    const taskState = files(path.join(directory, "task-authority"), ".json").flatMap(file => read(file));
    const sessions: TeamInput["sessions"] = [];
    const bindings = new Map<string, { actor: string; lead: boolean }>();
    const bind = (file: unknown, actor: unknown, isLead: boolean) => {
      if (typeof file !== "string" || typeof actor !== "string" || !file.endsWith(".jsonl")) return;
      const resolved = path.isAbsolute(file) ? file : path.resolve(directory, file);
      const previous = bindings.get(resolved);
      // Ambiguous ownership cannot safely produce a Worker action.
      if (previous && (previous.actor !== actor || previous.lead !== isLead)) {
        bindings.delete(resolved); ambiguous.add(resolved); return;
      }
      if (!ambiguous.has(resolved)) bindings.set(resolved, { actor, lead: isLead });
    };
    const ambiguous = new Set<string>();
    if (lead?.sessionFile) bind(lead.sessionFile, "team-lead", true);
    else if (typeof config.leadSessionId === "string") {
      const matches = sessionIndex.get(config.leadSessionId) ?? [];
      if (matches.length === 1) bind(matches[0], "team-lead", true);
      else stats.missingSessions++;
    }
    for (const member of Array.isArray(config.members) ? config.members : []) {
      if (!object(member)) continue;
      const isLead = member.agentType === "leader" || member.name === "team-lead" || member.agentId === config.leadAgentId;
      bind(member.sessionFile, isLead ? "team-lead" : member.name, isLead);
    }
    for (const [file, binding] of bindings) {
      const rows = read(file, true);
      if (!rows.length) { stats.missingSessions++; continue; }
      sessions.push({ identity: file, ...binding, rows });
    }
    const result = reconstruct({ config, events, runtime, taskState, sessions, provenance: digest.digest("hex") });
    for (const k of incidentNames) {
      aggregate[k].observed += result.incidents[k].observed;
      aggregate[k].candidate += result.incidents[k].candidate;
    }
    for (const k of Object.keys(coverage) as (keyof typeof coverage)[]) coverage[k] += result.coverage[k];
    if (!result.trace.steps.length) continue;
    for (const [index, item] of result.trace.steps.entries()) {
      kinds[item.step.kind]++;
      if (item.step.kind === "tool.call") toolActors[item.step.who.actor === "lead" ? "lead" : "worker"]++;
      if (index > 0 && item.at > result.trace.steps[index - 1].at) clockGaps++;
    }
    writeExternal(runDirectory, `${result.trace.id}.json`, `${JSON.stringify(result.trace)}\n`);
    manifest.push({ id: result.trace.id, steps: result.trace.steps.length, provenance: result.trace.provenance! });
  }
  let revision = "unavailable";
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" }).trim(); } catch { /* no source coordinates are emitted */ }
  const sourceDigest = createHash("sha256");
  for (const file of ["index.ts", "reconstruct.ts", "validate.ts", "../trace-format.ts"])
    sourceDigest.update(fs.readFileSync(path.join(__dirname, file)));
  const receipt = { schema: 1, extractorRevision: revision, extractorSourceDigest: sourceDigest.digest("hex"), node: process.versions.node, run,
    traces: manifest.length, stats, coverage, stepKinds: kinds, toolActors, clockGaps, incidents: aggregate, manifest };
  writeExternal(output, "manifest.json", `${JSON.stringify(receipt, null, 2)}\n`);
  const report = [
    "# Empirical WorldTrace corpus", "", `Traces: ${manifest.length}. Current run: ${run}.`,
    `Extractor revision: ${revision}. Node: ${process.versions.node}.`,
    `Extractor source digest: ${receipt.extractorSourceDigest}.`, "",
    "Inputs: Team config, lead binding, event journal, runtime snapshots, Task authority snapshots, and referenced native Sessions.",
    "Sources were opened read-only. Extraction is a live, non-atomic snapshot. Raw bytes remain in their original stores.",
    "The manifest holds SHA-256 source digests, counts, and current trace ids. It contains no source coordinates.", "",
    "## Step counts", "", "| Kind | Count |", "| --- | ---: |",
    ...Object.entries(kinds).map(([k, n]) => `| ${k} | ${n} |`), "",
    `Tool calls: lead ${toolActors.lead}; Worker ${toolActors.worker}. Positive clock gaps: ${clockGaps}.`, "",
    "## Incident classes", "", "Counts are evidence occurrences, not distinct real-world incidents. Classes can overlap.",
    "Candidate evidence does not add an inferred world action.", "", "| Class | Observed | Candidate |", "| --- | ---: | ---: |",
    ...incidentNames.map(k => `| ${k} | ${aggregate[k].observed} | ${aggregate[k].candidate} |`), "",
    "- Restart: distinct bound process generations for one Worker, or an explicit Session restart event.",
    "- Escape: explicit input event; an aborted assistant message is only a candidate.",
    "- PID reuse: repeated PID with different bound generation is a candidate. Death and host boot identity are unavailable.",
    "- Cursor replay: repeated explicit team_sync cursor is observed; duplicate event cursor is a candidate.",
    "- Stale binding: runtime Membership differs from active config; diagnostic text matches are candidates.",
    "- Pane loss: explicit pane-close event; missing-pane diagnostic matches are candidates.", "",
    "## Limits and treatment", "",
    "- Native Session JSONL usually lacks shutdown reasons, Escape keys, pane-close events, and OS events. Zero is unobserved, not absent.",
    "- Team stopped/failed state is not a quit, kill, or pane-close action. Runtime settled state has no agent_end timestamp.",
    "- Session entry ids suppress copied fork history per actor. Distinct branches remain observations; no single active lineage is claimed.",
    "- The first lead observation anchors pi.start. The nearest matching team_create before config creation starts the window when available. A different team_create ends unqualified lead actions.",
    "- Initial setup uses baseline semantics. Traces without team_create seed Team/Worker refs from Session bindings; this is an explicit partial-world assumption.",
    "- Cross-Session timestamp order is provisional. Equal timestamps keep source order. Step at values preserve clock gaps, never liveness evidence.",
    "- Compaction records map to pi.compact; branch-summary parents map to pi.tree targets. Both treatments carry assumption ids. No fork destination is invented from a parentSession alone.",
    "- Assistant stop maps to settled turn.end; it does not prove agent.settled. Aborted and error outcomes remain distinct.",
    "- Only allowlisted PTB tool calls enter traces. Tool names remain version-specific. Source prose, paths, names, pane ids and PIDs become opaque refs.",
    "- Redaction preserves equality and argument shape where keys are known. It does not preserve full executable Task/tool semantics.",
    "- Task and runtime snapshots contribute coverage and provenance, not fabricated world inputs. Missing or malformed records are counted.",
    "- No automatic inference promotes an incident candidate into a WorldStep. Synthetic fixtures cover unobservable OS/UI actions.", "",
    "## Coverage", "", "```json", JSON.stringify({ stats, coverage }, null, 2), "```", "",
    "Verification: every emitted trace passes the WorldTrace runtime validator. Synthetic extraction tests check ordering, privacy, and incident uncertainty.", "",
  ].join("\n");
  writeExternal(output, "REPORT.md", report);
  return { traces: manifest.length, incidents: aggregate, stats };
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(extractCorpus(), null, 2)}\n`); }
  catch { process.stderr.write("Trace extraction failed; no source details were printed.\n"); process.exitCode = 1; }
}
