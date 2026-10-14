import fs from "node:fs";
import path from "node:path";
import { GraphSnapshotCorruption, UnsupportedBeadsTeamError } from "../task-authority/graph-authority-errors";
import { configPath, graphTaskAuthorityPath, graphRevisionRetirementPath, teamDir } from "./paths";

/** Classify missing authority before a graph lock can create its directory. */
export function missingGraphAuthority(teamName: string): GraphSnapshotCorruption {
  const graphMarker = fs.existsSync(path.dirname(graphTaskAuthorityPath(teamName)))
    || fs.existsSync(graphRevisionRetirementPath(teamName));
  let config: { taskBackend?: string } = {};
  try { config = JSON.parse(fs.readFileSync(configPath(teamName), "utf8")); } catch {}
  return !graphMarker && (config.taskBackend === "beads" || fs.existsSync(path.join(teamDir(teamName), ".beads")))
    ? new UnsupportedBeadsTeamError()
    : new GraphSnapshotCorruption(`Team ${teamName} has no graph-native Task authority snapshot. Restore its graph authority before continuing.`);
}
