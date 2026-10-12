import fc from "fast-check";

export interface Choice {
  index: number;
  label: string;
  bound: number;
  value: number;
  enabled?: readonly string[];
}

/** One choice stream drives scheduling, ids, and faults. fast-check can shrink the tape. */
export class Entropy {
  readonly choices: Choice[] = [];
  private readonly tape: readonly number[];
  private cursor = 0;
  private scheduleCursor = 0;

  constructor(readonly seed: number, tape?: readonly number[], private readonly replay?: readonly Choice[], private readonly scheduleReplay?: readonly number[]) {
    this.tape = tape ?? fc.sample(fc.integer({ min: 0, max: 0x7fffffff }), { seed, numRuns: 65536 });
  }

  choose(label: string, bound: number, enabled?: readonly string[]): number {
    if (!Number.isSafeInteger(bound) || bound < 1) throw new Error(`Invalid choice bound: ${bound}`);
    const index = this.cursor++;
    const raw = this.tape[index];
    const expected = this.replay?.[index];
    if (this.replay && !expected) throw new Error(`Replay exhausted at ${label}`);
    if (!this.replay && raw === undefined) throw new Error(`Entropy tape exhausted at ${label}`);
    const scheduled = label === "schedule" && this.scheduleReplay ? this.scheduleReplay[this.scheduleCursor++] : undefined;
    if (label === "schedule" && this.scheduleReplay && scheduled === undefined) throw new Error("Scheduler receipt exhausted");
    const value = expected?.value ?? scheduled ?? ((raw! % bound) + bound) % bound;
    const choice: Choice = { index, label, bound, value, ...(enabled ? { enabled: [...enabled] } : {}) };
    if (!Number.isSafeInteger(value) || value < 0 || value >= bound || (expected && JSON.stringify(expected) !== JSON.stringify(choice))) {
      throw new Error(`Replay diverged at choice ${index}: ${label}`);
    }
    this.choices.push(choice);
    return value;
  }

  assertReplayComplete(): void {
    if (this.replay && this.cursor !== this.replay.length) throw new Error("Replay left unused choices");
    if (this.scheduleReplay && this.scheduleCursor !== this.scheduleReplay.length) throw new Error("Replay left unused scheduler choices");
  }

  float(): number { return this.choose("random.float", 0x80000000) / 0x80000000; }
  bytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid byte length");
    return Buffer.from(Array.from({ length }, () => this.choose("random.byte", 256)));
  }
  uuid(): string {
    const bytes = this.bytes(16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

export const choiceTape = fc.array(fc.integer({ min: 0, max: 0x7fffffff }), { minLength: 1, maxLength: 4096 });
