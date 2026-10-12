import type { SimProcess } from "../process-table";
import type { Witness } from "./types";

/**
 * S1 (sometimes, per campaign): PID reuse.
 *
 * Witness: in one boot, a pid is reused by a later process with a different birth
 * token, after the earlier process died. World truth only (the process table), so the
 * check needs no PTB claim. A campaign that never reaches this witness fails.
 */
export function pidReuseWitness(processes: readonly SimProcess[]): Witness<{ earlier: SimProcess; later: SimProcess }> {
  for (let i = 0; i < processes.length; i++) {
    const earlier = processes[i]!;
    if (earlier.alive) continue;
    for (let j = i + 1; j < processes.length; j++) {
      const later = processes[j]!;
      if (later.pid === earlier.pid && later.bootId === earlier.bootId && later.osBirthToken !== earlier.osBirthToken) {
        return { present: true, evidence: { earlier, later } };
      }
    }
  }
  return { present: false };
}
