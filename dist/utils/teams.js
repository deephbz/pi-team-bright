"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEMBERSHIP_MUTATION_LEASE_RETRIES = exports.TEAM_TOPOLOGY_LEASE_RETRIES = void 0;
exports.readLatestCutoverMarker = readLatestCutoverMarker;
exports.assertNoOrphanedBeadsCutover = assertNoOrphanedBeadsCutover;
exports.teamExists = teamExists;
exports.newMembershipId = newMembershipId;
exports.newLaunchId = newLaunchId;
exports.newTeamEpochId = newTeamEpochId;
exports.withTeamTopologyLease = withTeamTopologyLease;
exports.createTeam = createTeam;
exports.writeConfigAtomic = writeConfigAtomic;
exports.findLeadTeamForSession = findLeadTeamForSession;
exports.findTeammateBySessionFile = findTeammateBySessionFile;
exports.resolveCurrentLeadSessionBinding = resolveCurrentLeadSessionBinding;
exports.resolveCurrentTeammateSessionBinding = resolveCurrentTeammateSessionBinding;
exports.readConfig = readConfig;
exports.withCurrentConfig = withCurrentConfig;
exports.teamModelToolContractGap = teamModelToolContractGap;
exports.readLogicalWorker = readLogicalWorker;
exports.ensureLogicalWorker = ensureLogicalWorker;
exports.withMembershipMutationLease = withMembershipMutationLease;
exports.withCurrentSessionBinding = withCurrentSessionBinding;
exports.withCurrentMembershipLease = withCurrentMembershipLease;
exports.currentMembership = currentMembership;
exports.bindMemberSession = bindMemberSession;
exports.assertCurrentSessionBinding = assertCurrentSessionBinding;
exports.addMember = addMember;
exports.deactivateMember = deactivateMember;
exports.deactivateMembership = deactivateMembership;
exports.deactivateCurrentMembers = deactivateCurrentMembers;
exports.updateMember = updateMember;
exports.updateMembership = updateMembership;
exports.configureBeadsTaskBackend = configureBeadsTaskBackend;
const host_env_1 = require("../env/host-env");
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const terminal_target_1 = require("./terminal-target");
const paths_1 = require("./paths");
const paths = __importStar(require("./paths"));
const lock_1 = require("./lock");
const team_pane_layout_1 = require("./team-pane-layout");
const contracts_1 = require("../team-authority/contracts");
function cutoverMarkerCandidates(teamName) {
    const sourceDir = (0, paths_1.taskDir)(teamName);
    const defaultPath = node_path_1.default.join(sourceDir, `.pi-teams-${teamName}-cutover.jsonl`);
    if (!node_fs_1.default.existsSync(sourceDir))
        return [defaultPath];
    const additionalPaths = node_fs_1.default.readdirSync(sourceDir)
        .filter(fileName => fileName.endsWith("-cutover.jsonl"))
        .map(fileName => node_path_1.default.join(sourceDir, fileName));
    return [...new Set([defaultPath, ...additionalPaths])];
}
function parseCutoverMarker(markerPath) {
    if (!node_fs_1.default.existsSync(markerPath))
        return undefined;
    let lines;
    try {
        lines = node_fs_1.default.readFileSync(markerPath, "utf8").split("\n").filter(Boolean);
    }
    catch (error) {
        throw new Error(`Cannot read Beads cutover marker ${markerPath}; refusing to recreate the team until it is restored: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (lines.length === 0) {
        throw new Error(`Beads cutover marker ${markerPath} is empty; refusing to recreate the team until the cutover record is restored.`);
    }
    const events = lines.map((line, index) => {
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            throw new Error(`Beads cutover marker ${markerPath} is malformed at line ${index + 1}; refusing to recreate the team until it is restored.`);
        }
        if (!event || typeof event !== "object" || (event.state !== "prepared" && event.state !== "active")) {
            throw new Error(`Beads cutover marker ${markerPath} has an invalid state at line ${index + 1}; refusing to recreate the team.`);
        }
        if (typeof event.inventoryPath !== "string" || !event.inventoryPath || typeof event.inventorySha256 !== "string" || !/^[a-f0-9]{64}$/i.test(event.inventorySha256)) {
            throw new Error(`Beads cutover marker ${markerPath} lacks authenticated inventory evidence at line ${index + 1}; refusing to recreate the team.`);
        }
        if (event.workspace !== undefined && (typeof event.workspace !== "string" || !node_path_1.default.isAbsolute(event.workspace))) {
            throw new Error(`Beads cutover marker ${markerPath} has an invalid workspace at line ${index + 1}; refusing to recreate the team.`);
        }
        return event;
    });
    return events[events.length - 1];
}
/** Read the latest validated event from a migration marker. */
function readLatestCutoverMarker(markerPath) {
    return parseCutoverMarker(markerPath);
}
function findCutoverEvidence(teamName) {
    for (const markerPath of cutoverMarkerCandidates(teamName)) {
        const marker = parseCutoverMarker(markerPath);
        if (marker)
            return { markerPath, marker };
    }
    return undefined;
}
/** Refuse any new authority initialization when migration evidence outlived TeamConfig. */
function assertNoOrphanedBeadsCutover(teamName) {
    if (node_fs_1.default.existsSync((0, paths_1.configPath)(teamName)))
        return;
    const cutoverEvidence = findCutoverEvidence(teamName);
    if (cutoverEvidence) {
        throw new Error(`Team ${teamName} config is missing, but ${cutoverEvidence.marker.state} Beads cutover evidence exists at ${cutoverEvidence.markerPath}; refusing to initialize a new Task authority. Restore config.json from backup or perform an explicit Beads recovery review.`);
    }
}
function malformedConfigError(configFile, detail) {
    return new Error(`Team config ${configFile} is malformed (${detail}); refusing to overwrite it. Restore the file or move it aside only after reviewing its contents.`);
}
function validateConfigShape(value, configFile) {
    if (value.name !== undefined && typeof value.name !== "string")
        throw malformedConfigError(configFile, "name must be a string");
    if (value.epochId !== undefined && (typeof value.epochId !== "string" || !value.epochId)) {
        throw malformedConfigError(configFile, "epochId must be a non-empty string");
    }
    if (value.implementationVersion !== undefined && (typeof value.implementationVersion !== "string" || !value.implementationVersion)) {
        throw malformedConfigError(configFile, "implementationVersion must be a non-empty string");
    }
    if (value.logicalWorkers !== undefined && !Array.isArray(value.logicalWorkers)) {
        throw malformedConfigError(configFile, "logicalWorkers must be an array");
    }
    if (Array.isArray(value.logicalWorkers)) {
        const names = new Set();
        for (const [index, rawWorker] of value.logicalWorkers.entries()) {
            if (!rawWorker || typeof rawWorker !== "object" || Array.isArray(rawWorker)) {
                throw malformedConfigError(configFile, `logicalWorkers[${index}] must be an object`);
            }
            const worker = rawWorker;
            if (typeof worker.name !== "string" || !worker.name || typeof worker.scope !== "string" || !worker.scope.trim()) {
                throw malformedConfigError(configFile, `logicalWorkers[${index}] requires non-empty name and scope strings`);
            }
            if (worker.modelProfile !== undefined) {
                const profile = worker.modelProfile;
                if (!profile || typeof profile !== "object" || typeof profile.provider !== "string" || !profile.provider.trim() || profile.provider.includes("/") || typeof profile.model !== "string" || !profile.model.trim() || (profile.thinking !== undefined && !contracts_1.THINKING_LEVELS.includes(profile.thinking)) || (profile.alias !== undefined && (typeof profile.alias !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(profile.alias)))) {
                    throw malformedConfigError(configFile, `logicalWorkers[${index}].modelProfile is invalid`);
                }
            }
            try {
                (0, paths_1.sanitizeName)(worker.name);
            }
            catch (error) {
                throw malformedConfigError(configFile, error instanceof Error ? error.message : String(error));
            }
            if (names.has(worker.name))
                throw malformedConfigError(configFile, `logicalWorkers contains duplicate name ${worker.name}`);
            names.add(worker.name);
        }
    }
    if (value.members !== undefined && !Array.isArray(value.members))
        throw malformedConfigError(configFile, "members must be an array");
    if (value.terminalBackend !== undefined && (typeof value.terminalBackend !== "string" || !value.terminalBackend)) {
        throw malformedConfigError(configFile, "terminalBackend must be a non-empty string");
    }
    if (value.paneLayout !== undefined) {
        try {
            (0, team_pane_layout_1.normalizeTeamPaneLayout)(value.paneLayout, typeof value.terminalBackend === "string" ? value.terminalBackend : undefined);
        }
        catch (error) {
            throw malformedConfigError(configFile, error instanceof Error ? error.message : String(error));
        }
    }
    if (Array.isArray(value.members)) {
        for (const [index, rawMember] of value.members.entries()) {
            if (!rawMember || typeof rawMember !== "object" || Array.isArray(rawMember)) {
                throw malformedConfigError(configFile, `members[${index}] must be an object`);
            }
            const member = rawMember;
            if (member.modelProfile !== undefined) {
                const profile = member.modelProfile;
                if (!profile || typeof profile !== "object" || typeof profile.provider !== "string" || !profile.provider.trim() || profile.provider.includes("/") || typeof profile.model !== "string" || !profile.model.trim() || (profile.alias !== undefined && (typeof profile.alias !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(profile.alias))) || (profile.thinking !== undefined && !contracts_1.THINKING_LEVELS.includes(profile.thinking))) {
                    throw malformedConfigError(configFile, `members[${index}].modelProfile is invalid`);
                }
            }
            if (member.terminalTarget !== undefined) {
                try {
                    (0, terminal_target_1.assertTerminalTargetShape)(member.terminalTarget, `members[${index}].terminalTarget`);
                }
                catch (error) {
                    throw malformedConfigError(configFile, error instanceof Error ? error.message : String(error));
                }
                if (member.tmuxPaneId || member.windowId) {
                    throw malformedConfigError(configFile, `members[${index}] cannot combine terminalTarget with legacy terminal fields`);
                }
                if (member.isActive !== false && !value.terminalBackend) {
                    throw malformedConfigError(configFile, `current members[${index}].terminalTarget requires terminalBackend`);
                }
                if (member.isActive !== false && member.terminalTarget.backend !== value.terminalBackend) {
                    throw malformedConfigError(configFile, `current members[${index}].terminalTarget backend must match terminalBackend`);
                }
            }
            if (member.tmuxPaneId && member.windowId) {
                throw malformedConfigError(configFile, `members[${index}] cannot contain both legacy pane and window targets`);
            }
        }
    }
    if (value.taskBackend !== undefined && value.taskBackend !== "legacy" && value.taskBackend !== "beads") {
        throw malformedConfigError(configFile, "taskBackend must be legacy or beads");
    }
    if (value.taskWorkspace !== undefined && typeof value.taskWorkspace !== "string") {
        throw malformedConfigError(configFile, "taskWorkspace must be a string");
    }
    if (value.taskAuthorityId !== undefined && typeof value.taskAuthorityId !== "string") {
        throw malformedConfigError(configFile, "taskAuthorityId must be a string");
    }
    if (value.taskAuthorityFingerprint !== undefined) {
        const fingerprint = value.taskAuthorityFingerprint;
        if (!fingerprint
            || typeof fingerprint !== "object"
            || fingerprint.schema !== "pi-teams-beads-authority/1"
            || fingerprint.backend !== "dolt"
            || fingerprint.database !== "dolt"
            || typeof fingerprint.doltDatabase !== "string"
            || !fingerprint.doltDatabase
            || typeof fingerprint.projectId !== "string"
            || !fingerprint.projectId) {
            throw malformedConfigError(configFile, "taskAuthorityFingerprint must be a complete pi-teams-beads-authority/1 record");
        }
    }
    if (value.taskCutover !== undefined) {
        const cutover = value.taskCutover;
        if (!cutover || typeof cutover !== "object" || Array.isArray(cutover))
            throw malformedConfigError(configFile, "taskCutover must be an object");
        const record = cutover;
        if (typeof record.inventoryPath !== "string" || typeof record.inventorySha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.inventorySha256) || typeof record.cutoverAt !== "string") {
            throw malformedConfigError(configFile, "taskCutover has invalid inventory evidence");
        }
        if (record.markerPath !== undefined && typeof record.markerPath !== "string")
            throw malformedConfigError(configFile, "taskCutover.markerPath must be a string");
    }
}
function teamExists(teamName) {
    return node_fs_1.default.existsSync((0, paths_1.configPath)(teamName));
}
function newMembershipId() {
    return `membership_${(0, host_env_1.hostEnv)().random.uuid()}`;
}
function newLaunchId() {
    return `launch_${(0, host_env_1.hostEnv)().random.uuid()}`;
}
function newTeamEpochId() {
    return `team_epoch_${(0, host_env_1.hostEnv)().random.uuid()}`;
}
/** 600 lock attempts at 100 ms each: bounded to one minute. */
exports.TEAM_TOPOLOGY_LEASE_RETRIES = 600;
const activeTopologyLeases = new WeakSet();
function teamTopologyLeasePath(teamName) {
    // Validate the public identity, then keep coordination records outside the
    // Team directory so probing a missing Team does not create Team state.
    const safeName = (0, paths_1.sanitizeName)(teamName);
    const identity = node_crypto_1.default.createHash("sha256").update(safeName).digest("hex");
    return node_path_1.default.join(paths_1.PI_DIR, "team-topology-leases", identity);
}
/**
 * Serialize lifecycle/topology transactions for one Team. Callers must take
 * exact Membership leases only inside this lease, preserving the global order
 * topology -> Membership -> TeamConfig. Different Teams remain independent.
 */
async function withTeamTopologyLease(teamName, action, options = {}) {
    const safeName = (0, paths_1.sanitizeName)(teamName);
    return (0, lock_1.withLock)(teamTopologyLeasePath(safeName), async () => {
        const lease = { teamName: safeName };
        activeTopologyLeases.add(lease);
        try {
            return await action(lease);
        }
        finally {
            activeTopologyLeases.delete(lease);
        }
    }, options.retries ?? exports.TEAM_TOPOLOGY_LEASE_RETRIES);
}
function assertTopologyLease(teamName, lease) {
    const safeName = (0, paths_1.sanitizeName)(teamName);
    if (!activeTopologyLeases.has(lease) || lease.teamName !== safeName) {
        throw new Error(`Invalid or inactive topology lease for team ${safeName}.`);
    }
}
async function createTeam(name, sessionId, leadAgentId, description = "", defaultModel, separateWindows, taskWorkspace, taskAuthorityId, taskAuthorityFingerprint, topologyLease, terminalBinding, implementationVersion, paneLayout, syncLiveness) {
    if (!topologyLease) {
        return withTeamTopologyLease(name, (lease) => createTeam(name, sessionId, leadAgentId, description, defaultModel, separateWindows, taskWorkspace, taskAuthorityId, taskAuthorityFingerprint, lease, terminalBinding, implementationVersion, paneLayout, syncLiveness));
    }
    assertTopologyLease(name, topologyLease);
    if (paneLayout) {
        try {
            paneLayout = (0, team_pane_layout_1.normalizeTeamPaneLayout)(paneLayout, terminalBinding?.backend);
        }
        catch (error) {
            throw new Error(`Invalid Team pane layout: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (terminalBinding && (!terminalBinding.backend || typeof terminalBinding.backend !== "string")) {
        throw new Error("Team terminal binding requires a non-empty backend.");
    }
    if (terminalBinding?.leadTarget && terminalBinding.leadTarget.backend !== terminalBinding.backend) {
        throw new Error(`Lead terminal target uses ${terminalBinding.leadTarget.backend}, but Team ${name} is being bound to ${terminalBinding.backend}.`);
    }
    if (terminalBinding?.leadTarget)
        (0, terminal_target_1.assertTerminalTargetShape)(terminalBinding.leadTarget, "Lead terminal target");
    if ([taskWorkspace, taskAuthorityId, taskAuthorityFingerprint].filter(Boolean).length !== 0
        && [taskWorkspace, taskAuthorityId, taskAuthorityFingerprint].filter(Boolean).length !== 3) {
        throw new Error("Beads taskWorkspace, taskAuthorityId, and taskAuthorityFingerprint must be configured together.");
    }
    const dir = (0, paths_1.teamDir)(name);
    if (!node_fs_1.default.existsSync(dir))
        node_fs_1.default.mkdirSync(dir, { recursive: true });
    const priorConfigPath = (0, paths_1.configPath)(name);
    return (0, lock_1.withLock)(priorConfigPath, async () => {
        let priorAuthority = {};
        let priorMembers = [];
        let priorLogicalWorkers;
        if (node_fs_1.default.existsSync(priorConfigPath)) {
            const prior = readConfigRaw(priorConfigPath);
            const currentMembers = prior.members.filter((member) => member.isActive !== false);
            if (currentMembers.length > 0) {
                throw new Error(`Team ${name} still has current Memberships (${currentMembers.map((member) => member.name).join(", ")}); ` +
                    "run team_shutdown from its current lead before recreating the Team. team_create never implicitly stops processes or replaces live identities.");
            }
            priorMembers = structuredClone(prior.members);
            priorLogicalWorkers = prior.logicalWorkers === undefined ? undefined : structuredClone(prior.logicalWorkers);
            const cutoverEvidence = findCutoverEvidence(name);
            if (cutoverEvidence && prior.taskBackend !== "beads") {
                throw new Error(`Team ${name} has a ${cutoverEvidence.marker.state} Beads cutover marker at ${cutoverEvidence.markerPath}, but its config is not Beads-authoritative; refusing to reconnect the team to legacy tasks. Restore the Beads TeamConfig or complete an explicit recovery review.`);
            }
            if (prior.taskBackend === "beads") {
                if (!prior.taskWorkspace) {
                    throw new Error(`Team ${name} is marked Beads-authoritative but has no taskWorkspace; refusing to recreate it against legacy tasks. Restore the original TeamConfig and Beads workspace.`);
                }
                if (taskWorkspace && prior.taskWorkspace !== taskWorkspace) {
                    throw new Error(`Team ${name} already uses Beads workspace ${prior.taskWorkspace}; refusing to silently switch authority.`);
                }
                if (taskAuthorityId && prior.taskAuthorityId !== taskAuthorityId) {
                    throw new Error(`Team ${name} already has a different opaque Task authority identity; refusing to rebind it.`);
                }
                if (taskAuthorityFingerprint && JSON.stringify(prior.taskAuthorityFingerprint) !== JSON.stringify(taskAuthorityFingerprint)) {
                    throw new Error(`Team ${name} already has a different external Task authority fingerprint; refusing to rebind it.`);
                }
                priorAuthority = {
                    taskBackend: prior.taskBackend,
                    taskWorkspace: prior.taskWorkspace,
                    taskAuthorityId: prior.taskAuthorityId,
                    taskAuthorityFingerprint: prior.taskAuthorityFingerprint,
                    taskCutover: prior.taskCutover,
                };
                if (!priorAuthority.taskAuthorityId || !priorAuthority.taskAuthorityFingerprint) {
                    throw new Error(`Team ${name} has an incomplete Beads Task authority binding; restore taskAuthorityId and taskAuthorityFingerprint through an explicit recovery review.`);
                }
            }
            else if (taskWorkspace) {
                throw new Error(`Team ${name} still uses legacy JSON Task authority. Run: npm run migrate:tasks -- ${name} ${taskWorkspace}`);
            }
        }
        else {
            assertNoOrphanedBeadsCutover(name);
        }
        if (!taskWorkspace) {
            const tasksDir = (0, paths_1.taskDir)(name);
            if (!node_fs_1.default.existsSync(tasksDir))
                node_fs_1.default.mkdirSync(tasksDir, { recursive: true });
        }
        const leadMember = {
            membershipId: newMembershipId(),
            agentId: leadAgentId,
            name: "team-lead",
            agentType: "lead",
            joinedAt: (0, host_env_1.hostEnv)().clock.now(),
            ...(terminalBinding?.leadTarget ? { terminalTarget: structuredClone(terminalBinding.leadTarget) } : {}),
            cwd: (0, host_env_1.hostEnv)().process.cwd(),
            subscriptions: [],
            isActive: true,
            ...(sessionId ? { sessionFile: sessionId } : {}),
        };
        const config = {
            name,
            description,
            createdAt: (0, host_env_1.hostEnv)().clock.now(),
            leadAgentId,
            leadSessionId: sessionId,
            epochId: newTeamEpochId(),
            ...(implementationVersion ? { implementationVersion } : {}),
            logicalWorkers: priorLogicalWorkers ?? [],
            members: [...priorMembers, leadMember],
            ...(terminalBinding ? { terminalBackend: terminalBinding.backend } : {}),
            defaultModel,
            separateWindows,
            ...(paneLayout ? { paneLayout } : {}),
            ...(syncLiveness ? { syncLiveness: structuredClone(syncLiveness) } : {}),
            ...(taskWorkspace ? { taskBackend: "beads", taskWorkspace, taskAuthorityId, taskAuthorityFingerprint } : {}),
            ...priorAuthority,
        };
        writeConfigAtomic((0, paths_1.configPath)(name), config);
        return config;
    });
}
function readConfigRaw(p) {
    let value;
    try {
        value = JSON.parse(node_fs_1.default.readFileSync(p, "utf-8"));
    }
    catch (error) {
        throw malformedConfigError(p, error instanceof Error ? error.message : String(error));
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw malformedConfigError(p, "expected a JSON object");
    }
    validateConfigShape(value, p);
    return value;
}
function fsyncDirectory(dir) {
    try {
        const fd = node_fs_1.default.openSync(dir, "r");
        try {
            node_fs_1.default.fsyncSync(fd);
        }
        finally {
            node_fs_1.default.closeSync(fd);
        }
    }
    catch {
        // Directory fsync is not available on every supported local filesystem.
    }
}
/** Persist TeamConfig without exposing a truncated target file. */
function writeConfigAtomic(p, config) {
    const dir = node_path_1.default.dirname(p);
    const existing = node_fs_1.default.existsSync(p) ? node_fs_1.default.statSync(p) : undefined;
    if (existing && !existing.isFile())
        throw new Error(`Cannot replace TeamConfig ${p}: the existing path is not a regular file.`);
    const existingMode = existing ? existing.mode & 0o7777 : 0o600;
    const tempPath = node_path_1.default.join(dir, `.${node_path_1.default.basename(p)}.${(0, host_env_1.hostEnv)().process.pid}.${(0, host_env_1.hostEnv)().clock.now()}.${(0, host_env_1.hostEnv)().random.bytes(6).toString("hex")}.tmp`);
    let fd;
    try {
        // Start restrictive even when the eventual replacement must retain a
        // pre-existing mode; the temporary name is never created world-readable.
        fd = node_fs_1.default.openSync(tempPath, "wx", 0o600);
        node_fs_1.default.writeFileSync(fd, JSON.stringify(config, null, 2));
        node_fs_1.default.fsyncSync(fd);
        if (existing && existingMode !== 0o600)
            node_fs_1.default.fchmodSync(fd, existingMode);
        node_fs_1.default.fsyncSync(fd);
        node_fs_1.default.closeSync(fd);
        fd = undefined;
        node_fs_1.default.renameSync(tempPath, p);
        fsyncDirectory(dir);
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                node_fs_1.default.closeSync(fd);
            }
            catch {
                // Preserve the write error.
            }
        }
        try {
            node_fs_1.default.unlinkSync(tempPath);
        }
        catch {
            // The rename may have succeeded before a directory fsync failure.
        }
        throw error;
    }
}
/** Find the team this durable Pi Session leads. */
function findLeadTeamForSession(piSessionFile) {
    const teamsDir = paths.TEAMS_DIR;
    if (!node_fs_1.default.existsSync(teamsDir))
        return null;
    const sessionMatches = [];
    for (const teamDir of node_fs_1.default.readdirSync(teamsDir)) {
        try {
            const recordPath = paths.configPath(teamDir);
            if (!node_fs_1.default.existsSync(recordPath))
                continue;
            const config = JSON.parse(node_fs_1.default.readFileSync(recordPath, "utf-8"));
            const lead = [...(config.members || [])].reverse().find((member) => member.name === "team-lead" && member.isActive !== false);
            if (piSessionFile && lead?.sessionFile === piSessionFile)
                sessionMatches.push(teamDir);
        }
        catch {
            // Ignore corrupted session files.
        }
    }
    if (sessionMatches.length > 1) {
        throw new Error(`Ambiguous lead Session binding: this durable Pi Session is registered to multiple teams (${sessionMatches.join(", ")}). ` +
            "Refusing to choose by filesystem order. Set PI_TEAM_NAME to the intended current team before resuming, or repair the stale lead-session records.");
    }
    if (sessionMatches.length === 1)
        return sessionMatches[0];
    return null;
}
/**
 * Locate a teammate by the Pi session file it registered on first startup.
 * Session files survive a new process launched with `pi -r`, unlike PIDs and
 * terminal pane IDs. Invalid or incomplete foreign team records are ignored
 * during discovery; their owning operation will surface a precise error.
 */
function findTeammateBySessionFile(sessionFile) {
    if (!sessionFile || !node_fs_1.default.existsSync(paths_1.TEAMS_DIR))
        return null;
    const matches = [];
    for (const teamName of node_fs_1.default.readdirSync(paths_1.TEAMS_DIR)) {
        try {
            const configFile = (0, paths_1.configPath)(teamName);
            if (!node_fs_1.default.existsSync(configFile))
                continue;
            const config = readConfigRaw(configFile);
            const member = [...config.members].reverse().find(candidate => candidate.agentType === "teammate" && candidate.isActive !== false && candidate.sessionFile === sessionFile);
            if (member)
                matches.push({ teamName, member });
        }
        catch {
            // One malformed or concurrently removed team must not block other resumes.
        }
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous teammate Session binding: ${sessionFile} is current in multiple teams (${matches.map((match) => match.teamName).join(", ")}); refusing filesystem-order selection.`);
    }
    return matches[0] ?? null;
}
/** Discovery reads stable Membership identity before validating Team-specific policy. */
function configHasCurrentSession(file, sessionFile) {
    const value = JSON.parse(node_fs_1.default.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw malformedConfigError(file, "Session discovery requires a config object");
    }
    const record = value;
    const members = record.members === undefined ? [] : record.members;
    if (!Array.isArray(members))
        throw malformedConfigError(file, "members must be an array");
    let matches = false;
    for (const raw of members) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw malformedConfigError(file, "Session discovery requires Membership objects");
        }
        const member = raw;
        if (member.isActive !== undefined && typeof member.isActive !== "boolean") {
            throw malformedConfigError(file, "Membership isActive must be a boolean");
        }
        if (member.isActive === false)
            continue;
        if (member.sessionFile !== undefined && typeof member.sessionFile !== "string") {
            throw malformedConfigError(file, "Membership sessionFile must be a string");
        }
        if (member.sessionFile === sessionFile)
            matches = true;
    }
    return matches;
}
/**
 * Resolve one current lead Membership by exact durable Pi Session identity.
 * A strict scan and locked revalidation prevent filesystem order, names,
 * processes, terminal carriers, or a concurrently replaced epoch from binding.
 */
async function resolveCurrentLeadSessionBinding(sessionFile) {
    if (!sessionFile || !node_fs_1.default.existsSync(paths_1.TEAMS_DIR))
        return { status: "abstain", reason: "not_bound" };
    const exact = [];
    try {
        for (const teamName of node_fs_1.default.readdirSync(paths_1.TEAMS_DIR)) {
            const file = (0, paths_1.configPath)(teamName);
            if (!node_fs_1.default.existsSync(file))
                continue;
            if (!configHasCurrentSession(file, sessionFile))
                continue;
            const config = readConfigRaw(file);
            for (const member of config.members) {
                if (member.isActive !== false
                    && member.agentType === "lead"
                    && member.name === "team-lead"
                    && member.sessionFile === sessionFile) {
                    exact.push({ teamName, member: structuredClone(member), epochId: config.epochId });
                }
            }
        }
    }
    catch {
        return { status: "abstain", reason: "runtime_metadata_unavailable" };
    }
    if (exact.length === 0)
        return { status: "abstain", reason: "not_bound" };
    if (exact.length !== 1)
        return { status: "abstain", reason: "ambiguous_binding" };
    const candidate = exact[0];
    try {
        return await withCurrentConfig(candidate.teamName, async (config) => {
            const current = [...config.members].reverse().find((member) => member.isActive !== false
                && member.agentType === "lead"
                && member.name === "team-lead"
                && member.sessionFile === sessionFile);
            if (!current
                || config.epochId !== candidate.epochId
                || (candidate.member.membershipId !== undefined && current.membershipId !== candidate.member.membershipId)) {
                return { status: "abstain", reason: "stale_binding" };
            }
            return {
                status: "bound",
                teamName: candidate.teamName,
                member: structuredClone(current),
            };
        });
    }
    catch {
        return { status: "abstain", reason: "runtime_metadata_unavailable" };
    }
}
/**
 * Resolve an operation-specific exact teammate binding without using names,
 * environment, process, pane, or launch metadata. A strict scan refuses to
 * claim uniqueness when Membership identity is unreadable, then the winning
 * Membership generation is revalidated under its mutation and config locks.
 */
async function resolveCurrentTeammateSessionBinding(sessionFile) {
    if (!sessionFile || !node_fs_1.default.existsSync(paths_1.TEAMS_DIR))
        return { status: "abstain", reason: "not_bound" };
    const exact = [];
    try {
        for (const teamName of node_fs_1.default.readdirSync(paths_1.TEAMS_DIR)) {
            const file = (0, paths_1.configPath)(teamName);
            if (!node_fs_1.default.existsSync(file))
                continue;
            if (!configHasCurrentSession(file, sessionFile))
                continue;
            const config = readConfigRaw(file);
            for (const member of config.members) {
                if (member.isActive === false || member.sessionFile !== sessionFile)
                    continue;
                exact.push({ teamName, member: structuredClone(member) });
            }
        }
    }
    catch {
        return { status: "abstain", reason: "runtime_metadata_unavailable" };
    }
    if (exact.length === 0)
        return { status: "abstain", reason: "not_bound" };
    if (exact.length !== 1)
        return { status: "abstain", reason: "ambiguous_binding" };
    const candidate = exact[0];
    if (candidate.member.agentType !== "teammate" ||
        candidate.member.name === "team-lead")
        return { status: "abstain", reason: "leader_or_non_teammate" };
    if (!candidate.member.membershipId)
        return { status: "abstain", reason: "unverified_generation" };
    try {
        return await withMembershipMutationLease(candidate.teamName, candidate.member.membershipId, async () => withCurrentConfig(candidate.teamName, async (config) => {
            const current = config.members.find((member) => member.membershipId === candidate.member.membershipId &&
                member.isActive !== false &&
                member.agentType === "teammate" &&
                member.name !== "team-lead" &&
                member.sessionFile === sessionFile);
            return current
                ? {
                    status: "bound",
                    teamName: candidate.teamName,
                    member: structuredClone(current),
                }
                : { status: "abstain", reason: "stale_binding" };
        }));
    }
    catch {
        return { status: "abstain", reason: "runtime_metadata_unavailable" };
    }
}
async function readConfig(teamName) {
    const p = (0, paths_1.configPath)(teamName);
    if (!node_fs_1.default.existsSync(p)) {
        const cutoverEvidence = findCutoverEvidence(teamName);
        if (cutoverEvidence) {
            throw new Error(`Team ${teamName} config is missing, but ${cutoverEvidence.marker.state} Beads cutover evidence exists at ${cutoverEvidence.markerPath}; refusing to fall back to legacy tasks. Restore config.json from backup or perform an explicit Beads recovery review.`);
        }
        throw new Error(`Team ${teamName} not found`);
    }
    return await (0, lock_1.withLock)(p, async () => {
        return readConfigRaw(p);
    });
}
/** Hold current membership/config stable across a dependent filesystem write. */
async function withCurrentConfig(teamName, action) {
    const p = (0, paths_1.configPath)(teamName);
    if (!node_fs_1.default.existsSync(p))
        throw new Error(`Team ${teamName} not found`);
    return (0, lock_1.withLock)(p, async () => action(readConfigRaw(p)));
}
/** Legacy TeamConfig remains readable, but model-tool state cannot infer missing authority coordinates. */
function teamModelToolContractGap(config) {
    if (!config.epochId)
        return { kind: "contract_gap", reason: "team_epoch_missing" };
    if (!config.logicalWorkers)
        return { kind: "contract_gap", reason: "logical_workers_missing" };
    return undefined;
}
/** Read one stable logical Worker without consulting Membership or carrier state. */
async function readLogicalWorker(teamName, workerName) {
    (0, paths_1.sanitizeName)(workerName);
    return withCurrentConfig(teamName, async (config) => {
        const gap = teamModelToolContractGap(config);
        if (gap)
            return gap;
        const worker = config.logicalWorkers.find((candidate) => candidate.name === workerName);
        return worker ? { kind: "found", worker: structuredClone(worker) } : { kind: "not_found" };
    });
}
/**
 * Ensure durable Worker meaning under the TeamConfig lock. This operation does
 * not create, replace, inspect, or otherwise mutate Membership/carrier state.
 */
async function ensureLogicalWorker(teamName, input) {
    (0, paths_1.sanitizeName)(input.name);
    if (typeof input.scope !== "string" || !input.scope.trim()) {
        throw new Error("Logical Worker scope must be a non-empty string.");
    }
    if (input.modelProfile && (!input.modelProfile.provider.trim() || input.modelProfile.provider.includes("/") || !input.modelProfile.model.trim() || (input.modelProfile.alias !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(input.modelProfile.alias)) || (input.modelProfile.thinking !== undefined && !contracts_1.THINKING_LEVELS.includes(input.modelProfile.thinking)))) {
        throw new Error("Logical Worker modelProfile is invalid.");
    }
    const p = (0, paths_1.configPath)(teamName);
    if (!node_fs_1.default.existsSync(p))
        throw new Error(`Team ${teamName} not found`);
    return (0, lock_1.withLock)(p, async () => {
        const config = readConfigRaw(p);
        const gap = teamModelToolContractGap(config);
        if (gap)
            return gap;
        const existing = config.logicalWorkers.find((worker) => worker.name === input.name);
        if (existing) {
            const worker = structuredClone(existing);
            const sameProfile = input.modelProfile === undefined
                || JSON.stringify(existing.modelProfile ?? null) === JSON.stringify(input.modelProfile);
            return existing.scope === input.scope && sameProfile
                ? { kind: "reused", worker }
                : { kind: "scope_conflict", worker };
        }
        const worker = structuredClone(input);
        config.logicalWorkers.push(worker);
        writeConfigAtomic(p, config);
        return { kind: "created", worker: structuredClone(worker) };
    });
}
/** 600 lock attempts at 100 ms each: bounded to one minute. */
exports.MEMBERSHIP_MUTATION_LEASE_RETRIES = 600;
function membershipMutationLeasePath(teamName, membershipId) {
    if (!membershipId)
        throw new Error("A Membership identity is required for a mutation lease.");
    const directory = node_path_1.default.join((0, paths_1.teamDir)(teamName), "membership-mutation-leases");
    node_fs_1.default.mkdirSync(directory, { recursive: true });
    const identity = node_crypto_1.default.createHash("sha256").update(membershipId).digest("hex");
    return node_path_1.default.join(directory, identity);
}
/**
 * Serialize authority mutation and lifecycle transition for one exact
 * Membership generation without blocking unrelated team members. The lease
 * heartbeat is maintained by withLock, so a slow but live backend operation
 * cannot be mistaken for an abandoned writer.
 */
async function withMembershipMutationLease(teamName, membershipId, action, options = {}) {
    return (0, lock_1.withLock)(membershipMutationLeasePath(teamName, membershipId), action, options.retries ?? exports.MEMBERSHIP_MUTATION_LEASE_RETRIES);
}
/**
 * Hold one exact Membership generation's mutation lease, briefly revalidate
 * its Session binding under the TeamConfig lock, then release TeamConfig
 * before the external authority operation. Replacement and shutdown acquire
 * the same Membership lease, so no stale write can cross a generation while
 * unrelated members remain concurrent.
 */
async function withCurrentSessionBinding(teamName, agentName, sessionFile, expectedMembershipId, action) {
    if (!sessionFile || !expectedMembershipId)
        throw new Error("An exact Membership and durable Pi Session are required for a team-scoped mutation.");
    return withMembershipMutationLease(teamName, expectedMembershipId, async () => {
        const binding = await withCurrentConfig(teamName, async (config) => {
            const member = [...config.members].reverse().find((candidate) => candidate.name === agentName && candidate.isActive !== false);
            if (!member || member.membershipId !== expectedMembershipId || member.sessionFile !== sessionFile) {
                throw new Error(`Membership ${expectedMembershipId} / Session ${sessionFile} is not the current binding for ${agentName} on team ${teamName}; stale processes cannot mutate authority state.`);
            }
            return {
                config: structuredClone(config),
                member: structuredClone(member),
            };
        });
        return action(binding.config, binding.member);
    });
}
/**
 * Acquire the exact generation lease used by Task mutation, then verify that
 * generation is still current before a terminal/lifecycle side effect.
 */
async function withCurrentMembershipLease(teamName, membershipId, action) {
    return withMembershipMutationLease(teamName, membershipId, async () => {
        const member = await withCurrentConfig(teamName, async (config) => {
            const current = config.members.find((candidate) => candidate.membershipId === membershipId && candidate.isActive !== false);
            if (!current)
                throw new Error(`Membership ${membershipId} is no longer current in team ${teamName}.`);
            return structuredClone(current);
        });
        return action(member);
    });
}
async function currentMembership(teamName, agentName) {
    const config = await readConfig(teamName);
    const member = [...config.members].reverse().find((candidate) => candidate.name === agentName && candidate.isActive !== false);
    if (!member)
        throw new Error(`Agent ${agentName} is not a current member of team ${teamName}.`);
    if (!member.membershipId) {
        throw new Error(`Current Membership for ${agentName} on team ${teamName} has no membershipId; stop the team and respawn it with the current PiTeams version.`);
    }
    return structuredClone(member);
}
async function bindMemberSession(teamName, agentName, sessionFile, launchId, updates = {}, expectedMembershipId) {
    if (!sessionFile)
        throw new Error("A durable Pi Session file is required for Membership binding.");
    const p = (0, paths_1.configPath)(teamName);
    return (0, lock_1.withLock)(p, async () => {
        const config = readConfigRaw(p);
        const member = [...config.members].reverse().find((candidate) => candidate.name === agentName && candidate.isActive !== false);
        if (!member)
            throw new Error(`Agent ${agentName} is not a current member of team ${teamName}.`);
        if (!member.membershipId) {
            throw new Error(`Current Membership for ${agentName} on team ${teamName} has no membershipId; stop the team and respawn it.`);
        }
        if (expectedMembershipId && member.membershipId !== expectedMembershipId) {
            throw new Error(`Membership ${expectedMembershipId} is no longer the current generation for ${agentName} on team ${teamName}; ` +
                "refusing to bind a replacement Membership from a stale startup.");
        }
        if (member.sessionFile) {
            if (launchId)
                throw new Error(`Launch capability for ${agentName} has already been consumed; resume by exact Session binding without a launch ID.`);
            if (member.sessionFile !== sessionFile) {
                throw new Error(`Session ${sessionFile} cannot replace current binding ${member.sessionFile} for ${agentName} on team ${teamName}.`);
            }
        }
        else {
            if (!launchId || !member.pendingLaunchId || launchId !== member.pendingLaunchId) {
                throw new Error(`A matching pending launch capability is required for the first Session binding of ${agentName} on team ${teamName}.`);
            }
            member.sessionFile = sessionFile;
            member.pendingLaunchId = undefined;
            member.launchConsumedAt = new Date((0, host_env_1.hostEnv)().clock.now()).toISOString();
        }
        if (updates.terminalTarget) {
            (0, terminal_target_1.assertTerminalTargetShape)(updates.terminalTarget, "Membership terminal target");
            if (!config.terminalBackend || updates.terminalTarget.backend !== config.terminalBackend) {
                throw new Error(`Terminal target backend ${updates.terminalTarget.backend} does not match Team ${teamName} backend ${config.terminalBackend || "<missing>"}.`);
            }
        }
        Object.assign(member, updates);
        writeConfigAtomic(p, config);
        return structuredClone(member);
    });
}
async function assertCurrentSessionBinding(teamName, agentName, sessionFile) {
    if (!sessionFile)
        throw new Error("A durable Pi Session file is required for a team-scoped mutation.");
    const config = await readConfig(teamName);
    const member = [...config.members].reverse().find((candidate) => candidate.name === agentName && candidate.isActive !== false);
    if (!member)
        throw new Error(`Agent ${agentName} is not a current member of team ${teamName}.`);
    const bound = member.sessionFile;
    if (!bound || bound !== sessionFile) {
        throw new Error(`Session ${sessionFile} is not the current binding for ${agentName} on team ${teamName}; fork/stale Sessions cannot mutate team state.`);
    }
    return structuredClone(member);
}
async function addMember(teamName, member) {
    const p = (0, paths_1.configPath)(teamName);
    await (0, lock_1.withLock)(p, async () => {
        const config = readConfigRaw(p);
        const next = structuredClone(member);
        if (next.name === "team-lead" || next.agentType === "lead") {
            throw new Error("'team-lead' and lead Memberships are reserved for team creation.");
        }
        next.membershipId ||= newMembershipId();
        if (next.isActive !== false && next.agentType === "teammate") {
            if (!!next.sessionFile === !!next.pendingLaunchId) {
                throw new Error(`Current teammate Membership ${next.membershipId} must be exactly one of launch-prepared or Session-bound.`);
            }
        }
        if (next.terminalTarget) {
            (0, terminal_target_1.assertTerminalTargetShape)(next.terminalTarget, "Membership terminal target");
            if (!config.terminalBackend || next.terminalTarget.backend !== config.terminalBackend) {
                throw new Error(`Terminal target backend ${next.terminalTarget.backend} does not match Team ${teamName} backend ${config.terminalBackend || "<missing>"}.`);
            }
        }
        if (config.members.some((candidate) => candidate.membershipId === next.membershipId)) {
            throw new Error(`Duplicate membershipId ${next.membershipId} in team ${teamName}.`);
        }
        if (config.members.some((candidate) => candidate.name === next.name && candidate.isActive !== false)) {
            throw new Error(`A current member named ${next.name} already exists in team ${teamName}.`);
        }
        const workerLimit = config.paneLayout?.worker_limit;
        const activeWorkers = config.members.filter((candidate) => candidate.agentType === "teammate" && candidate.isActive !== false).length;
        if (next.isActive !== false && next.agentType === "teammate"
            && workerLimit !== undefined && activeWorkers >= workerLimit) {
            throw new Error(`Team Worker limit ${workerLimit} has been reached; stop a current Worker before ensuring another.`);
        }
        config.members.push(next);
        writeConfigAtomic(p, config);
    });
}
async function deactivateMember(teamName, agentName, reason) {
    const p = (0, paths_1.configPath)(teamName);
    return (0, lock_1.withLock)(p, async () => {
        const config = readConfigRaw(p);
        const member = config.members.find((candidate) => candidate.name === agentName && candidate.isActive !== false);
        if (!member)
            return null;
        member.isActive = false;
        member.deactivatedAt = new Date((0, host_env_1.hostEnv)().clock.now()).toISOString();
        member.deactivationReason = reason;
        writeConfigAtomic(p, config);
        return structuredClone(member);
    });
}
/** Deactivate exactly one Membership generation; never resolve by reusable name. */
async function deactivateMembership(teamName, membershipId, reason) {
    const p = (0, paths_1.configPath)(teamName);
    return (0, lock_1.withLock)(p, async () => {
        const config = readConfigRaw(p);
        const member = config.members.find((candidate) => candidate.membershipId === membershipId && candidate.isActive !== false);
        if (!member)
            return null;
        member.isActive = false;
        member.deactivatedAt = new Date((0, host_env_1.hostEnv)().clock.now()).toISOString();
        member.deactivationReason = reason;
        writeConfigAtomic(p, config);
        return structuredClone(member);
    });
}
async function deactivateCurrentMembers(teamName, reason) {
    const p = (0, paths_1.configPath)(teamName);
    return (0, lock_1.withLock)(p, async () => {
        const config = readConfigRaw(p);
        const current = config.members.filter((member) => member.isActive !== false);
        const staleBindings = config.members.filter((member) => member.isActive === false && !!(member.terminalTarget || member.tmuxPaneId || member.windowId));
        const at = new Date((0, host_env_1.hostEnv)().clock.now()).toISOString();
        for (const member of current) {
            member.isActive = false;
            member.deactivatedAt = at;
            member.deactivationReason = reason;
        }
        if (current.length > 0)
            writeConfigAtomic(p, config);
        return { deactivated: structuredClone(current), staleBindings: structuredClone(staleBindings) };
    });
}
async function updateMember(teamName, agentName, updates) {
    const p = (0, paths_1.configPath)(teamName);
    await (0, lock_1.withLock)(p, async () => {
        const config = readConfigRaw(p);
        const m = [...config.members].reverse().find(m => m.name === agentName && m.isActive !== false);
        if (m) {
            if (updates.terminalTarget) {
                (0, terminal_target_1.assertTerminalTargetShape)(updates.terminalTarget, "Membership terminal target");
                if (!config.terminalBackend || updates.terminalTarget.backend !== config.terminalBackend) {
                    throw new Error(`Terminal target backend ${updates.terminalTarget.backend} does not match Team ${teamName} backend ${config.terminalBackend || "<missing>"}.`);
                }
            }
            Object.assign(m, updates);
            writeConfigAtomic(p, config);
        }
    });
}
async function updateMembership(teamName, membershipId, updates) {
    const p = (0, paths_1.configPath)(teamName);
    return (0, lock_1.withLock)(p, async () => {
        const config = readConfigRaw(p);
        const member = config.members.find((candidate) => candidate.membershipId === membershipId && candidate.isActive !== false);
        if (!member)
            throw new Error(`Membership ${membershipId} is not current in team ${teamName}.`);
        if (updates.terminalTarget) {
            (0, terminal_target_1.assertTerminalTargetShape)(updates.terminalTarget, "Membership terminal target");
            if (!config.terminalBackend || updates.terminalTarget.backend !== config.terminalBackend) {
                throw new Error(`Terminal target backend ${updates.terminalTarget.backend} does not match Team ${teamName} backend ${config.terminalBackend || "<missing>"}.`);
            }
        }
        Object.assign(member, updates);
        writeConfigAtomic(p, config);
        return structuredClone(member);
    });
}
async function configureBeadsTaskBackend(teamName, taskWorkspace, taskAuthorityFingerprint, taskCutover) {
    const p = (0, paths_1.configPath)(teamName);
    if (!node_fs_1.default.existsSync(p))
        throw new Error(`Team ${teamName} not found`);
    return await (0, lock_1.withLock)(p, async () => {
        const config = readConfigRaw(p);
        if (config.taskBackend === "beads" && config.taskWorkspace && config.taskWorkspace !== taskWorkspace) {
            throw new Error(`Team ${teamName} is already cut over to Beads workspace ${config.taskWorkspace}; refusing to switch authority silently.`);
        }
        if (config.taskBackend === "beads" && config.taskAuthorityFingerprint
            && JSON.stringify(config.taskAuthorityFingerprint) !== JSON.stringify(taskAuthorityFingerprint)) {
            throw new Error(`Team ${teamName} is already bound to a different Beads authority fingerprint; refusing to switch authority silently.`);
        }
        config.taskBackend = "beads";
        config.taskWorkspace = taskWorkspace;
        config.taskAuthorityId ||= `task_authority_${(0, host_env_1.hostEnv)().random.uuid()}`;
        config.taskAuthorityFingerprint = taskAuthorityFingerprint;
        config.taskCutover = taskCutover;
        writeConfigAtomic(p, config);
        return config;
    });
}
