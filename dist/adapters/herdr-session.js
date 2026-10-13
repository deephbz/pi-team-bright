"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.herdrPiSessionPath = herdrPiSessionPath;
/** Decode Herdr AgentSessionInfo. A missing or foreign identity proves no Session match. */
function herdrPiSessionPath(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const session = value;
    return session.source === "herdr:pi" && session.agent === "pi" && session.kind === "path"
        && typeof session.value === "string" && session.value.length > 0 ? session.value : undefined;
}
