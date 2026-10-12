import { describe, expect, it } from "vitest";
import type { SimProcess } from "../process-table";
import { pidReuseWitness } from "./pid-reuse";

const process = (overrides: Partial<SimProcess>): SimProcess => ({
  actor: "w1",
  pid: 101,
  bootId: "boot-1",
  osBirthToken: "1",
  alive: true,
  command: "pi",
  ...overrides,
});

describe("S1 PID reuse witness", () => {
  it("passes when a dead pid is reused in the same boot with a new birth token", () => {
    const witness = pidReuseWitness([
      process({ actor: "w1", pid: 101, osBirthToken: "1", alive: false }),
      process({ actor: "unrelated", pid: 101, osBirthToken: "2", alive: true }),
    ]);
    expect(witness.present).toBe(true);
  });

  it("violates (no witness) when the pid is not reused", () => {
    const witness = pidReuseWitness([
      process({ actor: "w1", pid: 101, osBirthToken: "1", alive: false }),
      process({ actor: "w2", pid: 102, osBirthToken: "2", alive: true }),
    ]);
    expect(witness.present).toBe(false);
  });
});
