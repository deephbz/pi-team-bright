import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BeadsAuthorityFingerprint, TaskFile, TaskStatus, TeamConfig } from "./models";
import { taskDir, teamDir, sanitizeName } from "./paths";
import { configureBeadsTaskBackend, readConfig, readLatestCutoverMarker } from "./teams";
import {
  assertBeadsAuthorityFingerprint,
  assertBeadsWorkspaceRoot,
  BeadsTaskStore,
  BeadsTaskStoreOptions,
  readBeadsAuthorityFingerprint,
  TaskWriteOptions,
} from "./beads";
import { withLock } from "./lock";

const MIGRATION_SCHEMA = "pi-teams-task-migration/1";
// A real bd migration can take tens of seconds. Competing callers should wait
// for the authoritative result and then reconcile it, not fail after the
// generic five-second file-operation budget.
const MIGRATION_LOCK_RETRIES = 3000;

/** Exact historical JSON shape. It is migration evidence, never runtime Task API. */
export interface LegacyTaskFile {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "planning" | "in_progress" | "blocked" | "completed" | "deleted";
  plan?: string;
  planFeedback?: string;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface MigrationInventoryTask {
  legacyId: string;
  fileName: string;
  sha256: string;
  raw: string;
  task: LegacyTaskFile;
}

export interface MigrationInventory {
  schema: string;
  teamName: string;
  sourceDir: string;
  createdAt: string;
  tasks: MigrationInventoryTask[];
  inventorySha256: string;
}

export interface MigrationMismatch {
  legacyId: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface OrphanedLegacyWrite {
  fileName: string;
  kind: "changed" | "new";
  inventorySha256?: string;
  currentSha256: string;
}

export interface MigrationReport {
  schema: string;
  teamName: string;
  inventoryPath: string;
  inventorySha256: string;
  reportPath?: string;
  cutover: boolean;
  alreadyCutOver?: boolean;
  authority?: "legacy" | "beads";
  mapping: Record<string, string>;
  before: { count: number; legacyIds: string[] };
  after: { count: number; beadsIds: string[] };
  mismatches: MigrationMismatch[];
  orphanedLegacyWrites: OrphanedLegacyWrite[];
  errors: string[];
}

export interface MigrateTaskOptions {
  teamName: string;
  workspace: string;
  legacyTaskDir?: string;
  inventoryPath?: string;
  markerPath?: string;
  reportPath?: string;
  operatorOverridePath?: string;
  now?: () => Date;
  beads?: BeadsTaskStore;
  beadsOptions?: Omit<BeadsTaskStoreOptions, "teamName" | "workspace">;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalInventoryHash(tasks: MigrationInventoryTask[]): string {
  return sha256(canonicalJson(tasks.map(task => ({
    legacyId: task.legacyId,
    fileName: task.fileName,
    sha256: task.sha256,
    raw: task.raw,
    task: task.task,
  }))));
}

function defaultPaths(teamName: string, sourceDir: string): { inventoryPath: string; markerPath: string; overridePath: string } {
  const safe = sanitizeName(teamName);
  return {
    inventoryPath: path.join(sourceDir, `.pi-teams-${safe}-migration-inventory.json`),
    markerPath: path.join(sourceDir, `.pi-teams-${safe}-cutover.jsonl`),
    overridePath: path.join(sourceDir, `.pi-teams-${safe}-migration-override.json`),
  };
}

function writeImmutableJson(filePath: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(filePath)) {
    if (fs.readFileSync(filePath, "utf8") !== content) {
      throw new Error(`Refusing to replace immutable migration inventory ${filePath}; use the existing inventory and investigate the difference.`);
    }
    return;
  }
  fs.writeFileSync(filePath, content, { flag: "wx" });
}

function inventoryFromLegacy(teamName: string, sourceDir: string, now: Date): MigrationInventory {
  if (!fs.existsSync(sourceDir)) throw new Error(`Legacy task directory does not exist: ${sourceDir}`);
  const tasks: MigrationInventoryTask[] = fs.readdirSync(sourceDir)
    .filter(fileName => /^\d+\.json$/.test(fileName))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map(fileName => {
      const raw = fs.readFileSync(path.join(sourceDir, fileName), "utf8");
      const task = JSON.parse(raw) as LegacyTaskFile;
      return { legacyId: task.id, fileName, sha256: sha256(raw), raw, task };
    });
  const duplicateIds = duplicateValues(tasks.map(task => task.legacyId));
  if (duplicateIds.length > 0) throw new Error(`Duplicate legacy Task IDs in source inventory: ${duplicateIds.join(", ")}; refusing migration.`);
  assertDependencyTargets(tasks.map(item => item.task));
  return {
    schema: MIGRATION_SCHEMA,
    teamName,
    sourceDir,
    createdAt: now.toISOString(),
    tasks,
    inventorySha256: canonicalInventoryHash(tasks),
  };
}

function readInventory(filePath: string): MigrationInventory {
  const inventory = JSON.parse(fs.readFileSync(filePath, "utf8")) as MigrationInventory;
  if (inventory.schema !== MIGRATION_SCHEMA || !Array.isArray(inventory.tasks)) throw new Error(`Invalid migration inventory: ${filePath}`);
  for (const item of inventory.tasks) {
    if (!item || typeof item.raw !== "string" || typeof item.sha256 !== "string" || item.sha256 !== sha256(item.raw)) {
      throw new Error(`Migration inventory raw bytes failed authentication: ${filePath}`);
    }
    let parsed: LegacyTaskFile;
    try {
      parsed = JSON.parse(item.raw) as LegacyTaskFile;
    } catch {
      throw new Error(`Migration inventory contains invalid task JSON: ${filePath}`);
    }
    if (parsed.id !== item.legacyId || canonicalJson(parsed) !== canonicalJson(item.task)) {
      throw new Error(`Migration inventory task payload failed authentication: ${filePath}`);
    }
  }
  const duplicateIds = duplicateValues(inventory.tasks.map(task => task.legacyId));
  if (duplicateIds.length > 0) throw new Error(`Duplicate legacy Task IDs in migration inventory: ${duplicateIds.join(", ")}; refusing migration.`);
  assertDependencyTargets(inventory.tasks.map(item => item.task));
  const expectedHash = canonicalInventoryHash(inventory.tasks);
  if (expectedHash !== inventory.inventorySha256) throw new Error(`Migration inventory hash mismatch: ${filePath}`);
  return inventory;
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) seen.has(value) ? duplicates.add(value) : seen.add(value);
  return [...duplicates].sort();
}

function assertDependencyTargets(tasks: LegacyTaskFile[]): void {
  const ids = new Set(tasks.map(task => task.id));
  const missing = new Set<string>();
  for (const task of tasks) {
    for (const target of [...task.blockedBy, ...task.blocks]) {
      if (!ids.has(target)) missing.add(`${task.id}->${target}`);
    }
  }
  if (missing.size > 0) throw new Error(`Legacy Task dependencies reference missing targets: ${[...missing].sort().join(", ")}; refusing migration.`);
}

function hasDriftOverride(filePath: string, teamName: string, inventorySha256: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const override = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return override.schema === `${MIGRATION_SCHEMA}/operator-override`
      && override.teamName === teamName
      && override.inventorySha256 === inventorySha256
      && override.allowSourceDrift === true
      && typeof override.operator === "string"
      && typeof override.approvedAt === "string";
  } catch {
    return false;
  }
}

function legacyOrphans(inventory: MigrationInventory, sourceDir: string): OrphanedLegacyWrite[] {
  const expected = new Map(inventory.tasks.map(task => [task.fileName, task.sha256]));
  return fs.readdirSync(sourceDir)
    .filter(fileName => /^\d+\.json$/.test(fileName))
    .map(fileName => ({ fileName, currentSha256: sha256(fs.readFileSync(path.join(sourceDir, fileName), "utf8")) }))
    .reduce<OrphanedLegacyWrite[]>((orphans, current) => {
      const inventorySha256 = expected.get(current.fileName);
      if (!inventorySha256) orphans.push({ ...current, kind: "new" });
      else if (inventorySha256 !== current.currentSha256) orphans.push({ ...current, kind: "changed", inventorySha256 });
      return orphans;
    }, []);
}

function beadsStatus(status: LegacyTaskFile["status"]): TaskStatus {
  if (status === "completed" || status === "deleted") return "closed";
  if (status === "in_progress") return "in_progress";
  if (status === "blocked") return "blocked";
  return "open";
}

function comparable(task: TaskFile): Record<string, unknown> {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    design: task.design || "",
    assignee: task.assignee || "",
    blockedBy: task.relations.filter(relation => relation.relation === "blocked_by").map(relation => relation.targetId).sort(),
  };
}

function collectMismatches(legacy: LegacyTaskFile, actual: TaskFile, expectedBlockers: string[]): MigrationMismatch[] {
  const expected: Record<string, unknown> = {
    title: legacy.subject,
    description: legacy.description,
    status: beadsStatus(legacy.status),
    design: legacy.plan || "",
    assignee: legacy.owner || "",
    blockedBy: [...expectedBlockers].sort(),
  };
  const observed = comparable(actual);
  const fieldMismatches = Object.keys(expected).flatMap(field => JSON.stringify(expected[field]) === JSON.stringify(observed[field]) ? [] : [{
    legacyId: legacy.id,
    field,
    expected: expected[field],
    actual: observed[field],
  }]);
  return fieldMismatches;
}

function appendMarker(markerPath: string, event: Record<string, unknown>): void {
  fs.appendFileSync(markerPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function reportFile(report: MigrationReport, reportPath?: string): void {
  if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function reconcileCutoverAuthority(
  options: MigrateTaskOptions,
  config: TeamConfig,
  inventory: MigrationInventory,
  report: MigrationReport,
): Promise<void> {
  if (!config.taskWorkspace) {
    report.errors.push("TeamConfig is marked Beads-authoritative but has no taskWorkspace; refusing to guess the Task authority location.");
    return;
  }
  if (!config.taskAuthorityId) {
    report.errors.push("TeamConfig is marked Beads-authoritative but has no taskAuthorityId; refusing to mint or guess an authority identity during migration rerun. Restore the binding through an explicit authority-recovery review.");
    return;
  }
  if (!config.taskAuthorityFingerprint) {
    report.errors.push("TeamConfig is marked Beads-authoritative but has no taskAuthorityFingerprint; refusing to infer or rebind external authority identity during migration rerun. Restore it through an explicit authority-recovery review.");
    return;
  }

  const requestedWorkspace = path.resolve(options.workspace);
  const configuredWorkspace = path.resolve(config.taskWorkspace);
  if (requestedWorkspace !== configuredWorkspace) {
    report.errors.push(`Team is already cut over to Beads workspace ${configuredWorkspace}; refusing migration rerun against ${requestedWorkspace}. Re-run with the configured workspace.`);
    return;
  }
  try {
    assertBeadsAuthorityFingerprint(configuredWorkspace, config.taskAuthorityFingerprint);
  } catch (error) {
    report.errors.push(`${error instanceof Error ? error.message : String(error)} Restore that exact authority workspace before rerunning migration.`);
    return;
  }

  const beads = options.beads || new BeadsTaskStore({
    teamName: report.teamName,
    workspace: configuredWorkspace,
    authorityFingerprint: config.taskAuthorityFingerprint,
    ...(options.beadsOptions || {}),
    requireExpectedVersion: false,
  });
  const actualByLegacy = new Map<string, TaskFile>();
  try {
    // This is intentionally unconditional: an empty migration inventory must
    // still prove that the configured Beads authority is initialized,
    // reachable, and able to answer a team-scoped read.
    if (beads instanceof BeadsTaskStore) await beads.assertWorkspaceRoot(config.taskAuthorityFingerprint);
    await beads.list();
    for (const item of inventory.tasks) {
      const mapped = await beads.findByLegacyId(item.legacyId);
      if (!mapped) {
        report.mismatches.push({ legacyId: item.legacyId, field: "presence", expected: "present", actual: "missing" });
        continue;
      }
      const actual = await beads.read(mapped.id);
      actualByLegacy.set(item.legacyId, actual);
      report.mapping[item.legacyId] = actual.id;
    }
    report.after = {
      count: actualByLegacy.size,
      beadsIds: [...actualByLegacy.values()].map(task => task.id).sort(),
    };
    if (report.mismatches.length > 0) {
      report.errors.push("Post-cutover authority reconciliation could not find every migrated legacy Task mapping. No writes were attempted.");
    }
  } catch (error) {
    report.errors.push(`Could not reconcile the configured Beads Task authority: ${error instanceof Error ? error.message : String(error)}. No writes were attempted.`);
  }
}

async function migrateTeamTasksUnlocked(options: MigrateTaskOptions): Promise<MigrationReport> {
  const teamName = sanitizeName(options.teamName);
  const sourceDir = options.legacyTaskDir || taskDir(teamName);
  const paths = defaultPaths(teamName, sourceDir);
  const inventoryPath = options.inventoryPath || paths.inventoryPath;
  const markerPath = options.markerPath || paths.markerPath;
  const operatorOverridePath = options.operatorOverridePath || paths.overridePath;
  fs.mkdirSync(sourceDir, { recursive: true });
  const now = options.now || (() => new Date());
  const config = await readConfig(teamName);
  const activeMarker = readLatestCutoverMarker(markerPath);
  const inventory = fs.existsSync(inventoryPath)
    ? readInventory(inventoryPath)
    : inventoryFromLegacy(teamName, sourceDir, now());
  writeImmutableJson(inventoryPath, inventory);
  const orphanedLegacyWrites = legacyOrphans(inventory, sourceDir);

  const baseReport: MigrationReport = {
    schema: MIGRATION_SCHEMA,
    teamName,
    inventoryPath,
    inventorySha256: inventory.inventorySha256,
    reportPath: options.reportPath,
    cutover: false,
    mapping: {},
    before: { count: inventory.tasks.length, legacyIds: inventory.tasks.map(task => task.legacyId) },
    after: { count: 0, beadsIds: [] },
    mismatches: [],
    orphanedLegacyWrites,
    errors: [],
  };

  if (config.taskBackend === "beads" || activeMarker) {
    if (config.taskBackend !== "beads") {
      baseReport.errors.push(`Cutover marker is ${activeMarker?.state} but TeamConfig is not configured for Beads; refusing to reconnect to legacy authority. Restore config.json or perform an explicit Beads recovery review. No writes were attempted.`);
    }
    baseReport.alreadyCutOver = config.taskBackend === "beads" || activeMarker?.state === "active";
    baseReport.authority = config.taskBackend === "beads" ? "beads" : undefined;
    baseReport.cutover = config.taskBackend === "beads";
    if (config.taskBackend === "beads") {
      await reconcileCutoverAuthority(options, config, inventory, baseReport);
    }
    reportFile(baseReport, options.reportPath);
    return baseReport;
  }

  if (orphanedLegacyWrites.length > 0 && !hasDriftOverride(operatorOverridePath, teamName, inventory.inventorySha256)) {
    baseReport.errors.push(`Legacy source drift detected before cutover; refusing authority change. Persist an operator override at ${operatorOverridePath} only after reviewing the drift.`);
    reportFile(baseReport, options.reportPath);
    return baseReport;
  }

  let taskAuthorityFingerprint: BeadsAuthorityFingerprint;
  try {
    taskAuthorityFingerprint = readBeadsAuthorityFingerprint(options.workspace);
  } catch (error) {
    baseReport.errors.push(`${error instanceof Error ? error.message : String(error)} No Beads writes were attempted.`);
    reportFile(baseReport, options.reportPath);
    return baseReport;
  }

  const beads = options.beads || new BeadsTaskStore({
    teamName,
    workspace: options.workspace,
    authorityFingerprint: taskAuthorityFingerprint,
    ...(options.beadsOptions || {}),
    requireExpectedVersion: false,
  });
  const idMap = new Map<string, string>();
  const writeOptions: TaskWriteOptions = { actor: options.beadsOptions?.actor || "pi-teams-migration" };

  try {
    if (beads instanceof BeadsTaskStore) await beads.assertWorkspaceRoot(taskAuthorityFingerprint);
    for (const item of inventory.tasks) {
      const legacy = item.task;
      const existing = await beads.findByLegacyId(legacy.id);
      const existingForWrite = existing ? await beads.read(existing.id) : undefined;
      const metadata = {
        ...(legacy.metadata || {}),
        pi_teams_legacy_id: legacy.id,
        pi_teams_migration_schema: MIGRATION_SCHEMA,
        pi_teams_legacy_status: legacy.status,
        ...(legacy.activeForm ? { pi_teams_legacy_active_form: legacy.activeForm } : {}),
        ...(legacy.planFeedback ? { pi_teams_legacy_plan_feedback: legacy.planFeedback } : {}),
      };
      const desiredStatus = beadsStatus(legacy.status);
      const terminalStatus = desiredStatus === "closed"
        ? "closed" as const
        : undefined;
      // A Beads terminal transition is its own authority mutation. Reconcile
      // every non-terminal field first, then apply completion/deletion in a
      // separate pass after dependency import. This keeps the migration inside
      // the same contract enforced for normal runtime writes and lets a rerun
      // resume safely after any individual committed step.
      const fields: Partial<TaskFile> = {
        title: legacy.subject,
        description: legacy.description,
        design: legacy.plan,
        assignee: legacy.owner || "",
        ...(!terminalStatus ? { status: desiredStatus } : {}),
      };
      let task = existing
        ? await beads.update(existing.id, fields, { ...writeOptions, expectedVersion: existingForWrite?.version })
        : await beads.create({
            title: legacy.subject,
            description: legacy.description,
            design: legacy.plan,
            assignee: legacy.owner,
            internalMetadata: metadata,
            idempotencyKey: `migration:${inventory.inventorySha256}:${legacy.id}`,
          }, writeOptions);
      if (!existing) {
        const createdForWrite = await beads.read(task.id);
        task = await beads.update(task.id, fields, { ...writeOptions, expectedVersion: createdForWrite.version });
      }
      idMap.set(legacy.id, task.id);
      baseReport.mapping[legacy.id] = task.id;
    }

    for (const item of inventory.tasks) {
      const taskId = idMap.get(item.legacyId);
      if (!taskId) continue;
      for (const legacyBlocker of new Set(item.task.blockedBy)) {
        const blockerId = idMap.get(legacyBlocker);
        if (blockerId && blockerId !== taskId) {
          const current = await beads.read(taskId);
          await beads.mutateLink(taskId, { relation: "blocked_by", targetId: blockerId, action: "add" }, { ...writeOptions, expectedVersion: current.version });
        }
      }
      for (const legacyBlocked of new Set(item.task.blocks)) {
        const blockedId = idMap.get(legacyBlocked);
        if (blockedId && blockedId !== taskId) {
          const current = await beads.read(blockedId);
          await beads.mutateLink(blockedId, { relation: "blocked_by", targetId: taskId, action: "add" }, { ...writeOptions, expectedVersion: current.version });
        }
      }
    }

    for (const item of inventory.tasks) {
      const desiredStatus = beadsStatus(item.task.status);
      if (desiredStatus !== "closed") continue;
      const taskId = idMap.get(item.legacyId);
      if (!taskId) continue;
      const current = await beads.read(taskId);
      if (current.status !== desiredStatus) {
        await beads.update(taskId, { status: desiredStatus }, {
          ...writeOptions,
          expectedVersion: current.version,
          appendNote: `Imported terminal evidence from legacy Task ${item.legacyId} with status ${item.task.status}.`,
        });
      }
    }

    const actualByLegacy = new Map<string, TaskFile>();
    for (const item of inventory.tasks) {
      const beadsId = idMap.get(item.legacyId);
      if (!beadsId) continue;
      const actual = await beads.read(beadsId);
      actualByLegacy.set(item.legacyId, actual);
    }
    for (const item of inventory.tasks) {
      const actual = actualByLegacy.get(item.legacyId);
      if (!actual) {
        baseReport.mismatches.push({ legacyId: item.legacyId, field: "presence", expected: "present", actual: "missing" });
        continue;
      }
      const expectedBlockers = item.task.blockedBy.map(id => idMap.get(id)).filter((id): id is string => !!id);
      baseReport.mismatches.push(...collectMismatches(item.task, actual, expectedBlockers));
    }
    // The migration report describes the imported inventory, not the normal
    // runtime list projection (which intentionally hides deleted Tasks).
    // Count every authenticated mapping so a loss check cannot silently drop
    // a deleted legacy Task from its before/after evidence.
    baseReport.after = {
      count: actualByLegacy.size,
      beadsIds: [...actualByLegacy.values()].map(task => task.id).sort(),
    };
    if (baseReport.mismatches.length > 0) {
      baseReport.errors.push("Before/after reconciliation failed; the legacy source remains authoritative until this report is resolved.");
      reportFile(baseReport, options.reportPath);
      return baseReport;
    }

    appendMarker(markerPath, {
      state: "prepared",
      teamName,
      inventoryPath,
      inventorySha256: inventory.inventorySha256,
      workspace: options.workspace,
      taskAuthorityFingerprint,
    });
    const cutover = {
      inventoryPath,
      inventorySha256: inventory.inventorySha256,
      markerPath,
      cutoverAt: now().toISOString(),
    } satisfies NonNullable<TeamConfig["taskCutover"]>;
    await configureBeadsTaskBackend(teamName, options.workspace, taskAuthorityFingerprint, cutover);
    appendMarker(markerPath, { state: "active", taskAuthorityFingerprint, ...cutover });
    baseReport.cutover = true;
    baseReport.authority = "beads";
    reportFile(baseReport, options.reportPath);
    return baseReport;
  } catch (error) {
    baseReport.errors.push(error instanceof Error ? error.message : String(error));
    reportFile(baseReport, options.reportPath);
    return baseReport;
  }
}

export async function migrateTeamTasks(options: MigrateTaskOptions): Promise<MigrationReport> {
  const teamName = sanitizeName(options.teamName);
  const workspace = path.resolve(options.workspace);
  fs.mkdirSync(teamDir(teamName), { recursive: true });
  return withLock(
    path.join(teamDir(teamName), ".task-migration"),
    () => migrateTeamTasksUnlocked({ ...options, teamName, workspace }),
    MIGRATION_LOCK_RETRIES,
  );
}
