import path from "node:path";
import { migrateTeamTasks } from "../utils/task-migration";

function usage(): never {
  throw new Error("Usage: npm run migrate:tasks -- <team-name> <absolute-beads-workspace> [report-path]");
}

const [, , teamName, workspace, reportPath] = process.argv;
if (!teamName || !workspace || !path.isAbsolute(workspace)) usage();

async function main(): Promise<void> {
  try {
    const report = await migrateTeamTasks({ teamName, workspace, reportPath });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.cutover || report.mismatches.length > 0 || report.errors.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
