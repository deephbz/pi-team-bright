import { migrateLegacyTaskDeliveryEpoch } from "../utils/task-delivery-migration";

function usage(): never {
  throw new Error("Usage: npm run migrate:task-delivery -- <stopped-team-name>");
}

const [, , teamName] = process.argv;
if (!teamName) usage();

async function main(): Promise<void> {
  try {
    const receipt = await migrateLegacyTaskDeliveryEpoch(teamName);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
