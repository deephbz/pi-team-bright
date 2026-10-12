import fs from "node:fs";
import path from "node:path";
import type { ExecResult } from "../src/env/host-env";

/** Minimal external Beads wire for empty legacy stores. Graph Task authority remains real PTB code. */
export function emptyBdWire(args: readonly string[]): ExecResult {
  const index = args.indexOf("--directory");
  const workspace = index < 0 ? undefined : args[index + 1];
  if (!workspace) throw new Error("Simulated bd requires an explicit directory");
  const words = args.filter((word, i) => word !== "--json" && i !== index && i !== index + 1);
  const marker = path.join(workspace, ".beads");
  let output: unknown;
  switch (words[0]) {
    case "init":
      fs.mkdirSync(marker, { recursive: true });
      fs.writeFileSync(path.join(marker, "metadata.json"), JSON.stringify({ backend: "dolt", database: "dolt", dolt_database: "sim", project_id: `sim-${path.basename(workspace)}` }));
      return { stdout: "", stderr: "", status: 0 };
    case "where": output = { path: fs.realpathSync(marker), database_path: path.join(fs.realpathSync(marker), "embeddeddolt"), prefix: path.basename(workspace), schema_version: 1 }; break;
    case "list": output = []; break;
    default: throw new Error(`Unmodeled bd command: ${words[0]}`);
  }
  return { stdout: JSON.stringify(output), stderr: "", status: 0 };
}
