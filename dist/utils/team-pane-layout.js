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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TEAM_PANE_LAYOUT = exports.TeamPaneLayoutSchema = void 0;
exports.loadTeamPaneLayoutSettings = loadTeamPaneLayoutSettings;
exports.assertTeamPaneLayoutSupported = assertTeamPaneLayoutSupported;
exports.resolveTeamPaneLayout = resolveTeamPaneLayout;
exports.normalizeTeamPaneLayout = normalizeTeamPaneLayout;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const value_1 = require("typebox/value");
const typebox_1 = require("typebox");
/** Durable pane placement policy captured by a Team epoch. */
exports.TeamPaneLayoutSchema = typebox_1.Type.Object({
    leader_share: typebox_1.Type.Number({ exclusiveMinimum: 0.1, exclusiveMaximum: 1 }),
    worker_tiling: typebox_1.Type.Enum(["linear", "grid"]),
}, { additionalProperties: false });
exports.DEFAULT_TEAM_PANE_LAYOUT = Object.freeze({
    leader_share: 0.6,
    worker_tiling: "linear",
});
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function parsePolicy(value, source) {
    if (!(0, value_1.Check)(exports.TeamPaneLayoutSchema, value)) {
        let detail = "must contain leader_share > 0.1 and < 1, and worker_tiling linear or grid";
        try {
            detail = value_1.Value.Errors(exports.TeamPaneLayoutSchema, value).at(0)?.message ?? detail;
        }
        catch {
            // Keep the stable contract error when TypeBox cannot describe the value.
        }
        throw new Error(`Invalid pane_layout from ${source}: ${detail}.`);
    }
    return { leader_share: value.leader_share, worker_tiling: value.worker_tiling };
}
function settingsPaneLayout(file, source) {
    if (!fs.existsSync(file))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (error) {
        throw new Error(`Invalid pane_layout settings file ${file}: ${error instanceof Error ? error.message : String(error)}.`);
    }
    const namespace = isRecord(parsed) && isRecord(parsed.pi_team_bright) ? parsed.pi_team_bright : undefined;
    const team = namespace && isRecord(namespace.team) ? namespace.team : undefined;
    return team && Object.hasOwn(team, "pane_layout")
        ? team.pane_layout
        : undefined;
}
function agentDirectory(agentDir) {
    return agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}
/** Read only the global policy and, when trusted, the nearest project policy. */
function loadTeamPaneLayoutSettings(input) {
    const globalFile = path.join(agentDirectory(input.agentDir), "settings.json");
    const projectFile = path.join(input.cwd, ".pi", "settings.json");
    return {
        ...(input.projectTrusted ? { project: settingsPaneLayout(projectFile, "trusted project Pi settings") } : {}),
        global: settingsPaneLayout(globalFile, "global Pi settings"),
    };
}
/** Refuse policies that the selected terminal adapter cannot implement. */
function assertTeamPaneLayoutSupported(policy, backend) {
    if (policy.worker_tiling === "grid" && backend !== "herdr") {
        throw new Error(`Pane worker_tiling=grid is unsupported by terminal backend ${backend}; use worker_tiling=linear or a Herdr Team.`);
    }
    if (backend === "tmux" && Math.floor((1 - policy.leader_share) * 100) < 1) {
        throw new Error(`Pane leader_share=${policy.leader_share} leaves tmux no Worker pane; use leader_share <= 0.99.`);
    }
}
/** Resolve explicit input, trusted project settings, global settings, then defaults. */
function resolveTeamPaneLayout(input) {
    const selected = input.explicit !== undefined
        ? { value: input.explicit, source: "team_create" }
        : input.project !== undefined
            ? { value: input.project, source: "trusted project Pi settings" }
            : input.global !== undefined
                ? { value: input.global, source: "global Pi settings" }
                : undefined;
    const policy = selected ? parsePolicy(selected.value, selected.source) : { ...exports.DEFAULT_TEAM_PANE_LAYOUT };
    assertTeamPaneLayoutSupported(policy, input.backend);
    return policy;
}
/** Validate a policy already loaded from a TeamConfig or a direct adapter caller. */
function normalizeTeamPaneLayout(value, backend) {
    const policy = value === undefined ? { ...exports.DEFAULT_TEAM_PANE_LAYOUT } : parsePolicy(value, "team_create");
    if (backend)
        assertTeamPaneLayoutSupported(policy, backend);
    return policy;
}
