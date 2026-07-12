import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TaskFile, TeamConfig } from "./models";
import { taskDir, teamDir, sanitizeName } from "./paths";
import { configureBeadsTaskBackend, readConfig, readLatestCutoverMarker } from "./teams";
import { BeadsTaskStore, BeadsTaskStoreOptions, TaskWriteOptions } from "./beads";
import { withLock } from "./lock";

const MIGRATION_SCHEMA = "pi-teams-task-migration/1";
// A real bd migration can take tens of seconds. Competing callers should wait
// for the authoritative result and then reconcile it, not fail after the
// generic five-second file-operation budget.
const MIGRATION_LOCK_RETRIES = 3000;

export interface MigrationInventoryTask {
  legacyId: string;
  fileName: string;
  sha256: string;
  raw: string;
  task: TaskFile;
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
      const task = JSON.parse(raw) as TaskFile;
      return { legacyId: task.id, fileName, sha256: sha256(raw), raw, task };
    });
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
    let parsed: TaskFile;
    try {
      parsed = JSON.parse(item.raw) as TaskFile;
    } catch {
      throw new Error(`Migration inventory contains invalid task JSON: ${filePath}`);
    }
    if (parsed.id !== item.legacyId || canonicalJson(parsed) !== canonicalJson(item.task)) {
      throw new Error(`Migration inventory task payload failed authentication: ${filePath}`);
    }
  }
  const expectedHash = canonicalInventoryHash(inventory.tasks);
  if (expectedHash !== inventory.inventorySha256) throw new Error(`Migration inventory hash mismatch: ${filePath}`);
  return inventory;
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

function duplicateLegacyMappings(tasks: TaskFile[]): string[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const legacyId = task.metadata?.pi_teams_legacy_id;
    if (typeof legacyId === "string") counts.set(legacyId, (counts.get(legacyId) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
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

function beadsStatus(status: TaskFile["status"]): TaskFile["status"] {
  return status === "completed" ? "completed" : status === "deleted" ? "deleted" : status === "planning" ? "planning" : status === "in_progress" ? "in_progress" : "pending";
}

function comparable(task: TaskFile): Record<string, unknown> {
  return {
    subject: task.subject,
    description: task.description,
    status: task.status,
    activeForm: task.activeForm || "",
    plan: task.plan || "",
    planFeedback: task.planFeedback || "",
    owner: task.owner || "",
    blockedBy: [...task.blockedBy].sort(),
    blocks: [...task.blocks].sort(),
  };
}

function collectMismatches(legacy: TaskFile, actual: TaskFile, expectedBlockers: string[], expectedBlocks: string[]): MigrationMismatch[] {
  const expected = comparable({ ...legacy, status: beadsStatus(legacy.status), blockedBy: expectedBlockers, blocks: expectedBlocks });
  const observed = comparable(actual);
  return Object.keys(expected).flatMap(field => JSON.stringify(expected[field]) === JSON.stringify(observed[field]) ? [] : [{
    legacyId: legacy.id,
    field,
    expected: expected[field],
    actual: observed[field],
  }]);
}

function appendMarker(markerPath: string, event: Record<string, unknown>): void {
  fs.appendFileSync(markerPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function reportFile(report: MigrationReport, reportPath?: string): void {
  if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
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
    reportFile(baseReport, options.reportPath);
    return baseReport;
  }

  if (orphanedLegacyWrites.length > 0 && !hasDriftOverride(operatorOverridePath, teamName, inventory.inventorySha256)) {
    baseReport.errors.push(`Legacy source drift detected before cutover; refusing authority change. Persist an operator override at ${operatorOverridePath} only after reviewing the drift.`);
    reportFile(baseReport, options.reportPath);
    return baseReport;
  }

  const beads = options.beads || new BeadsTaskStore({
    teamName,
    workspace: options.workspace,
    ...(options.beadsOptions || {}),
    requireExpectedVersion: false,
  });
  const idMap = new Map<string, string>();
  const writeOptions: TaskWriteOptions = { actor: options.beadsOptions?.actor || "pi-teams-migration" };

  try {
    const initialDuplicates = duplicateLegacyMappings(await beads.list());
    if (initialDuplicates.length > 0) throw new Error(`Duplicate Beads legacy mappings for ${initialDuplicates.join(", ")}; refusing cutover.`);
    for (const item of inventory.tasks) {
      const legacy = item.task;
      const existing = await beads.findByLegacyId(legacy.id);
      const existingForWrite = existing ? await beads.read(existing.id) : undefined;
      const metadata = {
        ...(legacy.metadata || {}),
        pi_teams_legacy_id: legacy.id,
        pi_teams_migration_schema: MIGRATION_SCHEMA,
      };
      let task = existing
        ? await beads.update(existing.id, {
            subject: legacy.subject,
            description: legacy.description,
            activeForm: legacy.activeForm,
            plan: legacy.plan,
            planFeedback: legacy.planFeedback,
            owner: legacy.owner || "",
            metadata,
            status: beadsStatus(legacy.status),
          }, { ...writeOptions, expectedVersion: existingForWrite?.version })
        : await beads.create({
            subject: legacy.subject,
            description: legacy.description,
            activeForm: legacy.activeForm,
            metadata,
            idempotencyKey: `migration:${inventory.inventorySha256}:${legacy.id}`,
          }, writeOptions);
      if (!existing) {
        const createdForWrite = await beads.read(task.id);
        task = await beads.update(task.id, {
          subject: legacy.subject,
          description: legacy.description,
          activeForm: legacy.activeForm,
          plan: legacy.plan,
          planFeedback: legacy.planFeedback,
          owner: legacy.owner || "",
          metadata,
          status: beadsStatus(legacy.status),
        }, { ...writeOptions, expectedVersion: createdForWrite.version });
      }
      idMap.set(legacy.id, task.id);
      baseReport.mapping[legacy.id] = task.id;
    }

    const importedDuplicates = duplicateLegacyMappings(await beads.list());
    if (importedDuplicates.length > 0) throw new Error(`Duplicate Beads legacy mappings for ${importedDuplicates.join(", ")}; refusing cutover.`);

    for (const item of inventory.tasks) {
      const taskId = idMap.get(item.legacyId);
      if (!taskId) continue;
      for (const legacyBlocker of new Set(item.task.blockedBy)) {
        const blockerId = idMap.get(legacyBlocker);
        if (blockerId && blockerId !== taskId) {
          const current = await beads.read(taskId);
          await beads.addDependency(taskId, blockerId, { ...writeOptions, expectedVersion: current.version });
        }
      }
      for (const legacyBlocked of new Set(item.task.blocks)) {
        const blockedId = idMap.get(legacyBlocked);
        if (blockedId && blockedId !== taskId) {
          const current = await beads.read(blockedId);
          await beads.addDependency(blockedId, taskId, { ...writeOptions, expectedVersion: current.version });
        }
      }
    }

    const afterTasks = await beads.list();
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
      const expectedBlocks = item.task.blocks.map(id => idMap.get(id)).filter((id): id is string => !!id);
      baseReport.mismatches.push(...collectMismatches(item.task, actual, expectedBlockers, expectedBlocks));
    }
    baseReport.after = { count: afterTasks.length, beadsIds: afterTasks.map(task => task.id).sort() };
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
    });
    const cutover = {
      inventoryPath,
      inventorySha256: inventory.inventorySha256,
      markerPath,
      cutoverAt: now().toISOString(),
    } satisfies NonNullable<TeamConfig["taskCutover"]>;
    await configureBeadsTaskBackend(teamName, options.workspace, cutover);
    appendMarker(markerPath, { state: "active", ...cutover });
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
  const workspaceKey = sha256(workspace).slice(0, 32);
  return withLock(
    path.join(teamDir(teamName), `.task-migration-${workspaceKey}`),
    () => migrateTeamTasksUnlocked({ ...options, teamName, workspace }),
    MIGRATION_LOCK_RETRIES,
  );
}
