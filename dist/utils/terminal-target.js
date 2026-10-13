"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertTerminalTargetShape = assertTerminalTargetShape;
exports.terminalTarget = terminalTarget;
exports.memberTerminalTarget = memberTerminalTarget;
exports.assertTeamTerminalTarget = assertTeamTerminalTarget;
exports.hasPersistedTerminalTarget = hasPersistedTerminalTarget;
function validTarget(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const target = value;
    return typeof target.backend === "string" && !!target.backend
        && (target.kind === "pane" || target.kind === "window")
        && typeof target.targetId === "string" && !!target.targetId;
}
/** Validate the persisted shape without inferring backend ownership from an ID. */
function assertTerminalTargetShape(value, context) {
    if (!validTarget(value)) {
        throw new Error(`${context} must contain a non-empty backend, pane/window kind, and targetId.`);
    }
}
function terminalTarget(backend, kind, targetId) {
    const target = { backend, kind, targetId };
    assertTerminalTargetShape(target, "Terminal target");
    return target;
}
/**
 * Read a Member target. Legacy fields remain readable only when the Team or
 * caller already supplies the owning backend; target prefixes are never used
 * as backend evidence.
 */
function memberTerminalTarget(member, teamBackend) {
    if (member.terminalTarget)
        return { ...member.terminalTarget };
    if (!teamBackend)
        return undefined;
    if (member.windowId)
        return terminalTarget(teamBackend, "window", member.windowId);
    if (member.tmuxPaneId)
        return terminalTarget(teamBackend, "pane", member.tmuxPaneId);
    return undefined;
}
function assertTeamTerminalTarget(config, member) {
    const target = memberTerminalTarget(member, config.terminalBackend);
    if (!target)
        return undefined;
    if (!config.terminalBackend) {
        throw new Error(`Team ${config.name} has a terminal target for ${member.name} but no terminalBackend; stop the Team and migrate its terminal binding before lifecycle operations.`);
    }
    if (target.backend !== config.terminalBackend) {
        throw new Error(`Terminal target for ${member.name} uses ${target.backend}, but Team ${config.name} is bound to ${config.terminalBackend}; refusing a cross-backend lifecycle operation.`);
    }
    return target;
}
function hasPersistedTerminalTarget(member) {
    return !!(member.terminalTarget || member.tmuxPaneId || member.windowId);
}
