import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_TASK_GOAL_MAX_LENGTH = 1_600;
export const TASK_GOAL_MAX_LENGTH_SETTING = "pi_team_bright.task.goal_max_length";

export function parseTaskGoalMaxLength(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${TASK_GOAL_MAX_LENGTH_SETTING} must be a positive safe integer.`);
  }
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Global-only: every Session uses the same contract regardless of Worker cwd. */
export function loadTaskGoalMaxLength(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")): number {
  const file = path.join(agentDir, "settings.json");
  let root: unknown;
  try {
    root = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_TASK_GOAL_MAX_LENGTH;
    throw new Error(`Cannot load ${TASK_GOAL_MAX_LENGTH_SETTING} from ${file}.`, { cause: error });
  }
  if (!isRecord(root) || !Object.hasOwn(root, "pi_team_bright")) return DEFAULT_TASK_GOAL_MAX_LENGTH;
  const namespace = root.pi_team_bright;
  if (!isRecord(namespace)) throw new Error("pi_team_bright must be an object.");
  if (!Object.hasOwn(namespace, "task")) return DEFAULT_TASK_GOAL_MAX_LENGTH;
  if (!isRecord(namespace.task)) throw new Error("pi_team_bright.task must be an object.");
  return Object.hasOwn(namespace.task, "goal_max_length")
    ? parseTaskGoalMaxLength(namespace.task.goal_max_length)
    : DEFAULT_TASK_GOAL_MAX_LENGTH;
}
