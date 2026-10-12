import type { ActorRef, HistoryEntry, HistoryFact, Json, ProcessFact } from "../history";
import type { Verdict, WitnessVerdict } from "./types";

export type Entry<K extends HistoryFact["kind"]> = Extract<HistoryEntry, { kind: K }>;

export function ofKind<K extends HistoryFact["kind"]>(history: readonly HistoryEntry[], kind: K): Entry<K>[] {
  return history.filter((entry): entry is Entry<K> => entry.kind === kind);
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

export const pass = (): Verdict => ({ status: "pass" });
export const violation = (sequence: number, detail: string): Verdict => ({ status: "violation", sequence, detail });
export const notApplicable = (missing: string): Verdict => ({ status: "not_applicable", missing });
export const witnessed = (sequence: number, detail: string): WitnessVerdict => ({ status: "witnessed", sequence, detail });
export const absent = (): WitnessVerdict => ({ status: "absent" });
export const witnessNotApplicable = (missing: string): WitnessVerdict => ({ status: "not_applicable", missing });

export const lastSequence = (history: readonly HistoryEntry[]): number => history.at(-1)?.sequence ?? 0;
export const lastAt = (history: readonly HistoryEntry[]): number => history.at(-1)?.at ?? 0;
