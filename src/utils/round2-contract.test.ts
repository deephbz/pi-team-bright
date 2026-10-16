import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskDeliveryMembership } from "../../test/support/task-delivery-membership";
import * as paths from "./paths";
import * as teams from "./teams";
import { TaskChangeDelivery } from "./task-delivery";

const names: string[] = [];
async function fixture(suffix: string) {
  const name = `round2-graph-${suffix}-${process.pid}-${Date.now()}-${names.length}`; names.push(name);
  await teams.createTeam(name, `/tmp/${name}-lead.jsonl`, `lead@${name}`);
  await teams.addMember(name, { membershipId: teams.newMembershipId(), agentId: `worker@${name}`, name: "worker", agentType: "teammate", joinedAt: Date.now(), sessionFile: `/tmp/${name}-worker.jsonl`, cwd: process.cwd(), subscriptions: [], isActive: true });
  return { name, sessionFile: `/tmp/${name}-worker.jsonl` };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const name of names.splice(0)) fs.rmSync(paths.teamDir(name), { recursive: true, force: true }); });

describe("graph Task delivery contracts", () => {
  it("reconciles once at delivery start but never on periodic spool scans", async () => {
    vi.useFakeTimers();
    const { name, sessionFile } = await fixture("restart-only");
    const reconcile = vi.fn(async () => 0);
    const delivery = new TaskChangeDelivery({ sendMessage: vi.fn(), appendEntry: vi.fn() }, {
      teamName: name, recipient: "worker", sessionFile, pollMs: 10, membership: taskDeliveryMembership, reconcile,
    });
    await delivery.start([]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcile).toHaveBeenCalledTimes(1);
    delivery.stop();
  });
});
