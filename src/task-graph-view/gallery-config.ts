import fs from "node:fs";
import path from "node:path";
import {
  parseTaskGraphLimit,
  parseTaskGraphViewSource,
  type TaskGraphRecentLimit,
  type TaskGraphViewSource,
} from "./source";

export const TASK_DAG_ISLANDS_GALLERY_SCHEMA = "pi-team-bright/task-dag-islands-gallery/1" as const;
export const DEFAULT_TASK_DAG_ISLANDS_GALLERY_CONFIG = path.resolve(__dirname, "gallery/default.json");

export interface TaskDagIslandsGalleryConfig {
  schema: typeof TASK_DAG_ISLANDS_GALLERY_SCHEMA;
  name: string;
  review_now: string;
  initial_limit: TaskGraphRecentLimit;
  start_mode: "pan" | "select";
  expand_selected: boolean;
  source: TaskGraphViewSource;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Task DAG islands gallery config must be an object.");
  }
  return value as Record<string, unknown>;
}

/** Validate the durable gallery input before any text reaches the terminal. */
export function parseTaskDagIslandsGalleryConfig(value: unknown): TaskDagIslandsGalleryConfig {
  const config = record(value);
  const allowed = new Set(["schema", "name", "review_now", "initial_limit", "start_mode", "expand_selected", "source"]);
  const extra = Object.keys(config).find((key) => !allowed.has(key));
  if (extra) throw new Error(`Task DAG islands gallery config contains unsupported field ${JSON.stringify(extra)}.`);
  if (config.schema !== TASK_DAG_ISLANDS_GALLERY_SCHEMA) throw new Error("Task DAG islands gallery config schema is unsupported.");
  if (typeof config.name !== "string" || !config.name.trim()) throw new Error("Task DAG islands gallery config name must be nonempty.");
  const reviewNow = typeof config.review_now === "string" ? Date.parse(config.review_now) : Number.NaN;
  if (!Number.isFinite(reviewNow) || new Date(reviewNow).toISOString() !== config.review_now) {
    throw new Error("Task DAG islands gallery review_now must be a canonical ISO-8601 instant.");
  }
  if (config.start_mode !== "pan" && config.start_mode !== "select") throw new Error("Task DAG islands gallery start_mode must be pan or select.");
  if (typeof config.expand_selected !== "boolean") throw new Error("Task DAG islands gallery expand_selected must be boolean.");
  const initialLimit = parseTaskGraphLimit(String(config.initial_limit ?? ""));
  return {
    schema: TASK_DAG_ISLANDS_GALLERY_SCHEMA,
    name: config.name,
    review_now: config.review_now,
    initial_limit: initialLimit,
    start_mode: config.start_mode,
    expand_selected: config.expand_selected,
    source: parseTaskGraphViewSource(config.source),
  };
}

export function loadTaskDagIslandsGalleryConfig(configPath = DEFAULT_TASK_DAG_ISLANDS_GALLERY_CONFIG): TaskDagIslandsGalleryConfig {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Task DAG islands gallery config ${path.resolve(configPath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseTaskDagIslandsGalleryConfig(value);
}
