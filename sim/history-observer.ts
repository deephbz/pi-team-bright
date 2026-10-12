import fs from "node:fs";
import path from "node:path";
import type { ActorRef } from "./trace-format";
import { json, object, type HistoryFact, type JsonObject, type ObservationStamp, type RuntimeFact, type LaunchFact, type Json, type CarrierJournalFact } from "./history";

/** Reads persisted PTB bytes and public Pi branches. Never calls a PTB store or projection. */
export class HistoryObserver {
  private readonly files = new Map<string, string>();
  private readonly journals = new Map<string, string[]>();
  private readonly branches = new Map<string, string>();
  private readonly entries = new Set<string>();
  private readonly launches = new Map<string, string>();
  readonly leads = new Map<string, { actor: ActorRef; read: () => { sessionId: string; entries: unknown[] } }>();
  constructor(private readonly root: string, private readonly emit: (fact: HistoryFact) => void) {}

  sample(): void {
    const teamsRoot = path.join(this.root, ".pi", "teams");
    const seen = new Set<string>();
    const visit = (directory: string, team: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { visit(file, team); continue; }
        if (!entry.isFile() || (!entry.name.endsWith(".json") && entry.name !== "team-events.jsonl")) continue;
        const relative = path.relative(this.root, file);
        seen.add(relative);
        const text = fs.readFileSync(file, "utf8");
        if (this.files.get(relative) === text) continue;
        this.files.set(relative, text);
        if (entry.name === "team-events.jsonl") this.journal(team, relative, text);
        else this.record(team, relative, text);
      }
    };
    if (fs.existsSync(teamsRoot)) for (const team of fs.readdirSync(teamsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (team.isDirectory()) visit(path.join(teamsRoot, team.name), team.name);
    }
    for (const relative of [...this.files.keys()].sort()) if (!seen.has(relative)) {
      const team = relative.split(path.sep)[2]!;
      this.files.delete(relative);
      if (this.journals.delete(relative)) this.emit({ kind: "journal.reset", team, path: relative });
      else this.record(team, relative, null);
    }
    for (const { actor, read } of this.leads.values()) {
      const branch = read();
      const entries = branch.entries.map(value => object(json(value))!);
      const ids = entries.map(entry => String(entry.id));
      const key = `${actor.team}/${actor.actor}/${branch.sessionId}`;
      if (this.branches.get(key) !== JSON.stringify(ids)) {
        this.branches.set(key, JSON.stringify(ids));
        this.emit({ kind: "lead.branch", actor, sessionId: branch.sessionId, entryIds: ids });
      }
      for (const entry of entries) {
        const entryId = String(entry.id);
        if (this.entries.has(`${key}/${entryId}`)) continue;
        this.entries.add(`${key}/${entryId}`);
        const message = object(entry.message);
        const details = entry.customType === "ptb.team-update" ? object(entry.details) : message?.toolName === "team_sync" ? object(object(message.details)?.observation) : undefined;
        const stamp = this.stamp(details);
        this.emit({ kind: "lead.entry", actor, sessionId: branch.sessionId, entryId, entry,
          ...(stamp ? { stamp } : {}), ...(typeof message?.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}) });
      }
    }
  }
  private stamp(value: JsonObject | undefined): ObservationStamp | undefined {
    if (!value || typeof value.team !== "string" || typeof value.epoch !== "string" || typeof value.binding !== "string"
      || typeof value.from !== "number" || typeof value.through !== "number") return undefined;
    return { team: value.team, epoch: value.epoch, binding: value.binding, from: value.from, through: value.through };
  }
  private journal(team: string, file: string, text: string): void {
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    let previous = this.journals.get(file) ?? [];
    if (previous.some((line, index) => lines[index] !== line)) {
      this.emit({ kind: "journal.reset", team, path: file });
      previous = [];
    }
    for (let index = previous.length; index < lines.length; index++) {
      if (!lines[index]!.trim()) continue;
      try {
        const raw = object(JSON.parse(lines[index]!));
        if (!raw || typeof raw.type !== "string") throw new Error("Journal row is not a typed object");
        const carrierRaw = object(raw.carrier);
        const carrier: CarrierJournalFact | undefined = carrierRaw ? {
          ...(typeof carrierRaw.field === "string" ? { field: carrierRaw.field } : {}),
          ...(typeof carrierRaw.to === "string" ? { to: carrierRaw.to } : {}),
          ...(object(carrierRaw.generation) ? { generation: object(carrierRaw.generation)! } : {}),
          ...(object(carrierRaw.cause) ? { cause: object(carrierRaw.cause)! } : {}),
          ...(typeof carrierRaw.paneId === "string" ? { paneId: carrierRaw.paneId } : {}),
          ...(typeof carrierRaw.suspectedHumanStop === "boolean" ? { suspectedHumanStop: carrierRaw.suspectedHumanStop } : {}),
          ...(typeof carrierRaw.nextActionHint === "string" ? { nextActionHint: carrierRaw.nextActionHint } : {}),
        } : undefined;
        const cursorSeq = typeof raw.cursor === "string" && /^\d+$/.test(raw.cursor) ? Number(raw.cursor) : undefined;
        const seq = typeof raw.seq === "number" ? raw.seq : Number.isSafeInteger(cursorSeq) ? cursorSeq : undefined;
        this.emit({ kind: "journal.append", team, path: file, line: index + 1, event: {
          raw, ...(carrier ? { carrier } : {}), ...(seq === undefined ? {} : { seq }), type: raw.type, ...(typeof raw.cursor === "string" ? { cursor: raw.cursor } : {}),
          ...(typeof raw.at === "string" ? { at: raw.at } : {}), ...(typeof raw.phase === "string" ? { phase: raw.phase } : {}),
          ...(typeof raw.cause === "string" ? { cause: raw.cause } : {}), ...(typeof raw.paneId === "string" ? { paneId: raw.paneId } : {}),
          ...(typeof raw.suspectedHumanStop === "boolean" ? { suspectedHumanStop: raw.suspectedHumanStop } : {}),
          ...(typeof raw.worker === "string" ? { worker: raw.worker } : {}),
          ...(typeof raw.membershipId === "string" ? { membershipId: raw.membershipId } : {}), ...(object(raw.generation) ? { generation: object(raw.generation)! } : {}),
        } });
      } catch (error) { this.emit({ kind: "disk.invalid", team, path: file, text: lines[index]!, message: (error as Error).message }); }
    }
    this.journals.set(file, lines);
  }
  private record(team: string, file: string, text: string | null): void {
    let value: Json = null;
    if (text !== null) {
      try { value = JSON.parse(text); }
      catch (error) { this.emit({ kind: "disk.invalid", team, path: file, text, message: (error as Error).message }); return; }
    }
    const raw = object(value) ?? null;
    const isLaunch = file.split(path.sep).slice(3).some(part => /launch|reservation/.test(part));
    if (text !== null && !raw && (file.includes(`${path.sep}runtime${path.sep}`) || isLaunch || file.endsWith(`${path.sep}config.json`))) {
      this.emit({ kind: "disk.invalid", team, path: file, text, message: "Expected an object record" });
      return;
    }
    if (file.includes(`${path.sep}runtime${path.sep}`)) {
      const record: RuntimeFact | null = raw ? { raw } : null;
      if (record && raw) {
        for (const field of ["teamName", "agentName", "membershipId", "bootId", "osBirthToken"] as const) if (typeof raw[field] === "string") record[field] = raw[field];
        for (const field of ["pid", "startedAt", "lastHeartbeatAt"] as const) if (typeof raw[field] === "number") record[field] = raw[field];
        if (typeof raw.ready === "boolean") record.ready = raw.ready;
      }
      this.emit({ kind: "durable.runtime", team, path: file, record });
    } else if (isLaunch) this.emit({ kind: "durable.launch", team, path: file, source: "file", record: this.launch(raw) });
    else if (file.endsWith(`${path.sep}config.json`)) {
      this.emit({ kind: "durable.team", team, path: file, record: raw });
      const seen = new Set<string>();
      for (const item of Array.isArray(raw?.members) ? raw.members : []) {
        const member = object(item);
        if (!member || (!member.pendingLaunchId && !member.launchConsumedAt)) continue;
        const location = `${file}#members/${String(member.membershipId ?? member.name)}`;
        seen.add(location);
        const serialized = JSON.stringify(member);
        if (this.launches.get(location) !== serialized) {
          this.launches.set(location, serialized);
          this.emit({ kind: "durable.launch", team, path: location, source: "member", record: this.launch(member) });
        }
      }
      for (const location of [...this.launches.keys()]) if (location.startsWith(`${file}#members/`) && !seen.has(location)) {
        this.launches.delete(location);
        this.emit({ kind: "durable.launch", team, path: location, source: "member", record: null });
      }
    } else this.emit({ kind: "durable.record", team, path: file, record: value });
  }
  private launch(raw: JsonObject | null): LaunchFact | null {
    if (!raw) return null;
    return { raw, ...(typeof raw.membershipId === "string" ? { membershipId: raw.membershipId } : {}),
      ...(typeof raw.name === "string" ? { worker: raw.name } : {}),
      ...(typeof raw.pendingLaunchId === "string" ? { pendingLaunchId: raw.pendingLaunchId } : {}),
      ...(typeof raw.launchConsumedAt === "string" ? { launchConsumedAt: raw.launchConsumedAt } : {}) };
  }
}
