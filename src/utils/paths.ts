import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const PI_DIR = path.join(os.homedir(), ".pi");
export const TEAMS_DIR = path.join(PI_DIR, "teams");
export const TASKS_DIR = path.join(PI_DIR, "tasks");

export function ensureDirs() {
  if (!fs.existsSync(PI_DIR)) fs.mkdirSync(PI_DIR);
  if (!fs.existsSync(TEAMS_DIR)) fs.mkdirSync(TEAMS_DIR);
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR);
}

export function sanitizeName(name: string): string {
  // Allow only alphanumeric characters, hyphens, and underscores.
  if (!name) {
    throw new Error("Invalid name: names must not be empty.");
  }
  if (/[^a-zA-Z0-9_-]/.test(name)) {
    throw new Error(`Invalid name: "${name}". Only alphanumeric characters, hyphens, and underscores are allowed.`);
  }
  return name;
}

export function teamDir(teamName: string) {
  return path.join(TEAMS_DIR, sanitizeName(teamName));
}

export function taskDir(teamName: string) {
  return path.join(TASKS_DIR, sanitizeName(teamName));
}

export function inboxPath(teamName: string, agentName: string) {
  return path.join(teamDir(teamName), "inboxes", `${sanitizeName(agentName)}.json`);
}

/** Task-authority-local delivery evidence for one resolved recipient. */
export function taskDeliveryPath(teamName: string, agentName: string) {
  return path.join(teamDir(teamName), "task-delivery", `${sanitizeName(agentName)}.json`);
}

export function taskDeliveryTombstonePath(teamName: string, agentName: string) {
  return path.join(teamDir(teamName), "task-delivery", `${sanitizeName(agentName)}.observed.json`);
}

export function taskDeliveryRecoveryPath(teamName: string) {
  return path.join(teamDir(teamName), "task-delivery", "recovery.json");
}

/** Durable adapter intent for Task ownership-change delivery recovery. */
export function taskOwnerTransitionOutboxPath(teamName: string) {
  // Keep the historical filename: changing it would orphan unresolved durable
  // recovery evidence during an otherwise agent-surface-only migration.
  return path.join(teamDir(teamName), "task-delivery", "owner-transitions.json");
}

export function runtimeStatusPath(teamName: string, agentName: string) {
  return path.join(teamDir(teamName), "runtime", `${sanitizeName(agentName)}.json`);
}

export function configPath(teamName: string) {
  return path.join(teamDir(teamName), "config.json");
}

export function leadSessionPath(teamName: string) {
  return path.join(teamDir(teamName), "lead-session.json");
}
