"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MISSING_GENERATION_HELPER_MESSAGE = void 0;
exports.linuxStartToken = linuxStartToken;
exports.probeProcessGenerations = probeProcessGenerations;
exports.probeProcessGeneration = probeProcessGeneration;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
exports.MISSING_GENERATION_HELPER_MESSAGE = "The macOS process-generation helper is missing. Install Rust (rustc) and Xcode Command Line Tools, then run npm run build:process-generation in the installed @hypercarrier/pi-team-bright directory. Retry after the build.";
const helperFailure = (error) => ({ kind: "unknown",
    reason: error?.code === "ENOENT" ? "generation_helper_missing" : "generation_helper_unavailable" });
/** Field 22 follows a parenthesized comm which can itself contain spaces and ')'. */
function linuxStartToken(stat) {
    if (!/^\d+ \(/.test(stat) || stat.lastIndexOf(")") < 0)
        return undefined;
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? "") ? fields[19] : undefined;
}
function parseReply(pid, line) {
    const [id, state, osBirthToken, bootId] = line.trim().split(/\s+/);
    if (id !== String(pid))
        return { kind: "unknown", reason: "malformed_generation_reply" };
    if (state === "absent")
        return { kind: "absent" };
    if (state === "found" && /^\d+:\d+$/.test(osBirthToken ?? "") && /^\d+:\d+$/.test(bootId ?? ""))
        return { kind: "found", generation: { pid, osBirthToken, bootId } };
    return { kind: "unknown", reason: "generation_verifier_unavailable" };
}
/** A poll uses one bounded helper invocation for the whole Team. */
async function probeProcessGenerations(pids) {
    const unique = [...new Set(pids)].filter(pid => Number.isSafeInteger(pid) && pid > 1);
    if (process.platform !== "darwin")
        return new Map(unique.map(pid => [pid, probeProcessGeneration(pid)]));
    if (!unique.length)
        return new Map();
    const helper = node_path_1.default.resolve(__dirname, "../../native/bin/process-generation");
    return new Promise(resolve => {
        (0, node_child_process_1.execFile)(helper, unique.map(String), { encoding: "utf8", timeout: 2000 }, (error, stdout) => {
            const lines = new Map(String(stdout ?? "").trim().split("\n").map(line => [Number(line.split(/\s+/)[0]), line]));
            resolve(new Map(unique.map(pid => [pid, error ? helperFailure(error) : parseReply(pid, lines.get(pid) ?? "")])));
        });
    });
}
function probeProcessGeneration(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1)
        return { kind: "unknown", reason: "invalid_pid" };
    try {
        if (process.platform === "linux") {
            let bootId;
            try {
                bootId = node_fs_1.default.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
            }
            catch {
                return { kind: "unknown", reason: "boot_identity_unavailable" };
            }
            const osBirthToken = linuxStartToken(node_fs_1.default.readFileSync(`/proc/${pid}/stat`, "utf8"));
            return bootId && osBirthToken ? { kind: "found", generation: { pid, osBirthToken, bootId } }
                : { kind: "unknown", reason: "malformed_proc_stat" };
        }
        if (process.platform === "darwin") {
            const helper = node_path_1.default.resolve(__dirname, "../../native/bin/process-generation");
            const result = (0, node_child_process_1.spawnSync)(helper, [String(pid)], { encoding: "utf8", timeout: 2000 });
            if (result.error || result.status !== 0)
                return helperFailure(result.error);
            return parseReply(pid, result.stdout);
        }
        return { kind: "unknown", reason: "generation_verifier_unavailable" };
    }
    catch (error) {
        const code = error.code;
        return code === "ENOENT" || code === "ESRCH" ? { kind: "absent" }
            : { kind: "unknown", reason: code ?? "generation_read_failed" };
    }
}
