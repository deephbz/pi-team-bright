import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

export type WorkerDefaultModelOverride = {
  scope: "global" | "project";
  value?: string;
  error?: string;
};

export interface WorkerResourcePolicy {
  replaceGlobal?: { path: string; content: string };
  appendGlobal?: { path: string; content: string };
  defaultModel?: WorkerDefaultModelOverride;
  enable: string[];
  disable: string[];
  diagnostics: string[];
}

export interface WorkerLaunchResources {
  aggregatePath?: string;
  projectTrusted: boolean;
  policy: WorkerResourcePolicy;
}

type JsonRecord = Record<string, unknown>;
const MAX_DIAGNOSTICS = 8;
const MAX_BYTES = 256 * 1024;
const aggregateDirectory = () => path.join(os.tmpdir(), "pi-team-bright-worker-resources");
const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === "object" && !Array.isArray(value);
const warn = (policy: WorkerResourcePolicy, message: string) => {
  if (policy.diagnostics.length < MAX_DIAGNOSTICS) policy.diagnostics.push(message);
};

function json(file: string, policy: WorkerResourcePolicy): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    if (fs.existsSync(file)) warn(policy, `Pi settings at ${file} are unreadable; Worker projection ignored.`);
    return undefined;
  }
}

function worker(root?: JsonRecord): JsonRecord | undefined {
  const namespace = root?.pi_team_bright;
  return isRecord(namespace) && isRecord(namespace.worker) ? namespace.worker : undefined;
}

function workerDefaultModel(root: JsonRecord | undefined, scope: WorkerDefaultModelOverride["scope"]): WorkerDefaultModelOverride | undefined {
  if (!root || !Object.hasOwn(root, "default_model")) return undefined;
  const value = root.default_model;
  if (typeof value !== "string" || !value.trim()) {
    return { scope, error: "must be a nonempty qualified provider/model string" };
  }
  return { scope, value: value.trim() };
}

function activeAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** Confirm an exact provider/model setting from Pi's current available-model list. */
export function resolveQualifiedWorkerDefaultModel(modelName: string): string | null {
  try {
    const result = spawnSync("pi", ["--list-models"], { encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0 || !result.stdout) return null;
    return result.stdout.split("\n").some((line) => {
      const [provider, model] = line.trim().split(/\s+/, 3);
      return `${provider}/${model}` === modelName;
    }) ? modelName : null;
  } catch {
    return null;
  }
}

function names(value: unknown, policy: WorkerResourcePolicy, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    warn(policy, `${label} must be an array of tool names; it was ignored.`);
    return [];
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}

function file(value: unknown, policy: WorkerResourcePolicy, label: string): { path: string; content: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    warn(policy, `${label} must be an absolute path; it was ignored.`);
    return undefined;
  }
  try {
    if (!fs.statSync(value).isFile() || fs.statSync(value).size > MAX_BYTES) throw new Error("unavailable");
    return { path: value, content: fs.readFileSync(value, "utf8") };
  } catch {
    warn(policy, `${label} is unavailable or exceeds 256 KiB; it was ignored.`);
    return undefined;
  }
}

/** Pi's public saved-trust lookup, including its nearest parent decision. */
export function savedProjectTrust(cwd: string, agentDir = activeAgentDir()): boolean | undefined {
  try {
    const decision = new ProjectTrustStore(agentDir).get(cwd);
    return decision === null ? undefined : decision;
  } catch {
    return undefined;
  }
}

export function loadWorkerResourcePolicy(input: { cwd: string; projectTrusted: boolean; agentDir?: string }): WorkerResourcePolicy {
  const policy: WorkerResourcePolicy = { enable: [], disable: [], diagnostics: [] };
  const agentDir = input.agentDir ?? activeAgentDir();
  const global = worker(json(path.join(agentDir, "settings.json"), policy));
  const project = input.projectTrusted ? worker(json(path.join(input.cwd, ".pi", "settings.json"), policy)) : undefined;
  const globalTools = isRecord(global?.tools) ? global.tools : undefined;
  const projectTools = isRecord(project?.tools) ? project.tools : undefined;
  const globalAgents = isRecord(global?.agents) ? global.agents : undefined;
  const projectAgents = isRecord(project?.agents) ? project.agents : undefined;
  const agents = { ...globalAgents, ...projectAgents };

  policy.defaultModel = workerDefaultModel(project, "project") ?? workerDefaultModel(global, "global");
  policy.enable = names(projectTools?.enable ?? globalTools?.enable, policy, "worker.tools.enable");
  policy.disable = names(projectTools?.disable ?? globalTools?.disable, policy, "worker.tools.disable");
  policy.replaceGlobal = file(agents.replace_global, policy, "worker.agents.replace_global");
  policy.appendGlobal = file(agents.append_global, policy, "worker.agents.append_global");
  return policy;
}

/** Resolve the fixed CLI launch policy before Pi builds the first Worker prompt. */
export function resolveWorkerLaunchResources(input: {
  cwd: string;
  leaderCwd: string;
  leaderProjectTrusted: boolean;
  agentDir?: string;
}): WorkerLaunchResources {
  const sameCwd = path.resolve(input.cwd) === path.resolve(input.leaderCwd);
  const savedTrust = sameCwd ? undefined : savedProjectTrust(input.cwd, input.agentDir);
  const projectTrusted = sameCwd ? input.leaderProjectTrusted : savedTrust === true;
  const policy = loadWorkerResourcePolicy({ cwd: input.cwd, projectTrusted, agentDir: input.agentDir });
  if (!sameCwd && savedTrust === undefined) {
    warn(policy, "Worker cwd has no saved Pi trust decision; launched with --no-approve and global settings only.");
  }
  return {
    aggregatePath: materializeWorkerAggregate({ cwd: input.cwd, policy, agentDir: input.agentDir }),
    projectTrusted,
    policy,
  };
}

export function projectWorkerTools(active: readonly string[], registered: readonly string[], policy: WorkerResourcePolicy): string[] {
  const known = new Set(registered);
  const selected = new Set(active);
  for (const name of policy.enable) {
    if (known.has(name)) selected.add(name);
    else warn(policy, `Unknown enabled tool '${name}' was ignored.`);
  }
  for (const name of policy.disable) {
    if (known.has(name)) selected.delete(name);
    else warn(policy, `Unknown disabled tool '${name}' was ignored.`);
  }
  return [...selected].filter(name => !policy.disable.includes(name));
}

function contextFile(directory: string): { path: string; content: string } | undefined {
  for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    const candidate = path.join(directory, name);
    try {
      if (fs.statSync(candidate).isFile()) return { path: candidate, content: fs.readFileSync(candidate, "utf8") };
    } catch {
      // A missing or unreadable native context file preserves Pi's fail-open discovery behavior.
    }
  }
  return undefined;
}

function wrap(context: { path: string; content: string }): string {
  return `<project_instructions path="${context.path}">\n${context.content}\n</project_instructions>`;
}

export function ownsWorkerAggregate(file: string | undefined): file is string {
  return !!file && path.dirname(path.resolve(file)) === path.resolve(aggregateDirectory());
}

/**
 * Materialize a private CLI append prompt. Pi reports this as appended content;
 * getAgentsFiles is empty. A forced refresh restores native content when both
 * Worker paths disappear while a fixed CLI append path remains active.
 */
export function materializeWorkerAggregate(input: {
  cwd: string;
  policy: WorkerResourcePolicy;
  agentDir?: string;
  target?: string;
  force?: boolean;
}): string | undefined {
  const { policy } = input;
  if (!policy.replaceGlobal && !policy.appendGlobal && !input.force) return undefined;

  const agentDir = input.agentDir ?? activeAgentDir();
  const sections: string[] = [];
  const global = contextFile(agentDir);
  const seenPaths = new Set<string>();
  if (policy.replaceGlobal) sections.push(wrap(policy.replaceGlobal));
  else if (global) {
    sections.push(wrap(global));
    seenPaths.add(global.path);
  }

  const ancestors: Array<{ path: string; content: string }> = [];
  let directory = path.resolve(input.cwd);
  while (true) {
    const context = contextFile(directory);
    if (context && !seenPaths.has(context.path)) {
      ancestors.unshift(context);
      seenPaths.add(context.path);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  sections.push(...ancestors.map(wrap));
  if (policy.appendGlobal) sections.push(wrap(policy.appendGlobal));

  const root = aggregateDirectory();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const target = input.target ?? path.join(root, `${randomUUID()}.md`);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${sections.join("\n\n")}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    return target;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Remove only a private aggregate created by this package. Cleanup is best effort. */
export function removeWorkerAggregate(file: string | undefined): void {
  if (!ownsWorkerAggregate(file)) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // The aggregate is disposable and must never change Worker lifecycle outcomes.
  }
}
