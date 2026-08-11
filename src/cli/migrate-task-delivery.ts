import { migrateLegacyTaskDeliveryEpoch } from "../utils/task-delivery-migration";
import { DurableTaskAuthorityRead } from "../adapters/durable-task-authority-read";
import { DurableTaskAuthorityReadTeam } from "../adapters/durable-task-authority-read-team";
import { createReadOnlyBeadsTaskAdapterFactory } from "../model-tool-contract/beads-task-adapter";

function usage(): never {
  throw new Error("Usage: npm run migrate:task-delivery -- <stopped-team-name>");
}

const [, , teamName] = process.argv;
if (!teamName) usage();

async function main(): Promise<void> {
  try {
    const team = new DurableTaskAuthorityReadTeam();
    const read = new DurableTaskAuthorityRead(team);
    const receipt = await migrateLegacyTaskDeliveryEpoch(teamName, createReadOnlyBeadsTaskAdapterFactory(read));
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
