"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskVersionRefSchema = void 0;
exports.taskVersionRef = taskVersionRef;
const node_crypto_1 = require("node:crypto");
const typebox_1 = require("typebox");
exports.TaskVersionRefSchema = typebox_1.Type.String({ pattern: "^v_[0-9a-f]{16}$", minLength: 18, maxLength: 18 });
/** Stable model-facing version token. Authority versions never leave the shell. */
function taskVersionRef(sourceRevision) {
    return `v_${(0, node_crypto_1.createHash)("sha256").update(sourceRevision).digest("hex").slice(0, 16)}`;
}
