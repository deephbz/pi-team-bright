import type { ActorRef, HistoryEntry, HistoryFact, Json, ProcessFact } from "../history";
import type { Verdict, WitnessVerdict } from "./types";

export type Entry<K extends HistoryFact["kind"]> = Extract<HistoryEntry, { kind: K }>;

export function ofKind<K extends HistoryFact["kind"]>(history: readonly HistoryEntry[], kind: K): Entry<K>[] {
  return history.filter(entry => entry.kind === kind).map((entry: HistoryEntry) => {
    if (entry.kind !== "journal.append" || !entry.event.carrier) return entry;
    const carrier = entry.event.carrier;
    // Compatibility accessor for monitor vocabulary. Canonical history keeps raw bytes unchanged.
    // Production calls a blocked-attention publication `blocked`; E4 calls it `attention`.
    const field = carrier.field === "blocked" ? "attention" : carrier.field;
    return { ...entry, event: { ...entry.event,
      ...(carrier.generation ? { generation: carrier.generation } : {}),
      ...(carrier.paneId === undefined ? {} : { paneId: carrier.paneId }),
      ...(carrier.suspectedHumanStop === undefined ? {} : { suspectedHumanStop: carrier.suspectedHumanStop }),
      ...(typeof carrier.cause?.source === "string" ? { cause: carrier.cause.source } : {}),
      raw: { ...entry.event.raw, ...(field === undefined ? {} : { field }), ...(carrier.to === undefined ? {} : { to: carrier.to }) },
    } };
  }) as Entry<K>[];
}

export interface Generation {
  pid: number;
  bootId: string;
  osBirthToken: string;
}

export const genKey = (generation: Generation) => `${generation.pid}:${generation.bootId}:${generation.osBirthToken}`;
export const actorKey = (ref: ActorRef) => `${ref.team}/${ref.actor}`;

/** Reads an exact process generation from a raw JSON object. Missing fields yield undefined. */
export function generationOf(value: Json | undefined): Generation | undefined {
  const object = value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  if (!object || typeof object.pid !== "number" || typeof object.bootId !== "string" || typeof object.osBirthToken !== "string") {
    return undefined;
  }
  return { pid: object.pid, bootId: object.bootId, osBirthToken: object.osBirthToken };
}

/** World truth: process generations alive after every entry up to and including `sequence`. */
export function liveAt(history: readonly HistoryEntry[], sequence: number): Map<string, ProcessFact> {
  const live = new Map<string, ProcessFact>();
  for (const entry of history) {
    if (entry.sequence > sequence) break;
    if (entry.kind === "process.birth") live.set(genKey(entry.process.generation), entry.process);
    if (entry.kind === "process.death") live.delete(genKey(entry.process.generation));
  }
  return live;
}

/** True when a fault is active at some entry inside [from, to]. Such windows are N/A under assumption. */
export function faultInWindow(history: readonly HistoryEntry[], from: number, to: number): boolean {
  const active = new Set<string>();
  for (const entry of history) {
    if (entry.at > to) break;
    if (entry.kind === "fault.set") active.add(entry.fault.source);
    if (entry.kind === "fault.clear") active.delete(entry.source);
    if (entry.at >= from && active.size) return true;
  }
  return false;
}

export const pass = (): Verdict => ({ status: "pass" });
export const violation = (sequence: number, detail: string): Verdict => ({ status: "violation", sequence, detail });
export const notApplicable = (missing: string): Verdict => ({ status: "not_applicable", missing });
export const witnessed = (sequence: number, detail: string): WitnessVerdict => ({ status: "witnessed", sequence, detail });
export const absent = (): WitnessVerdict => ({ status: "absent" });
export const witnessNotApplicable = (missing: string): WitnessVerdict => ({ status: "not_applicable", missing });

export const lastSequence = (history: readonly HistoryEntry[]): number => history.at(-1)?.sequence ?? 0;
export const lastAt = (history: readonly HistoryEntry[]): number => history.at(-1)?.at ?? 0;
