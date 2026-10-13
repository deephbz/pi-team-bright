"use strict";
/**
 * Terminal Adapter Interface
 *
 * Abstracts terminal multiplexer operations (tmux, iTerm2, Zellij)
 * to provide a unified API for spawning, managing, and terminating panes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.execCommand = execCommand;
exports.shellQuote = shellQuote;
exports.appleScriptQuote = appleScriptQuote;
exports.powershellQuote = powershellQuote;
exports.spawnArgv = spawnArgv;
exports.validateLegacyCommand = validateLegacyCommand;
exports.validateSpawnOptions = validateSpawnOptions;
exports.shellCommand = shellCommand;
exports.powershellCommand = powershellCommand;
const host_env_1 = require("../env/host-env");
/**
 * Base helper for adapters to execute commands synchronously.
 */
function execCommand(command, args) {
    return (0, host_env_1.hostEnv)().exec.runSync(command, args);
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function appleScriptQuote(value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}
function powershellQuote(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
function validatedEnv(options) {
    return Object.entries(options.env)
        .filter(([key]) => key.startsWith("PI_"))
        .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error(`Invalid environment variable name: ${key}`);
        return [key, value];
    });
}
function spawnArgv(options) {
    if (options.argv && options.command)
        throw new Error("SpawnOptions must use argv or command, not both.");
    if (options.argv) {
        if (options.argv.length === 0 || options.argv.some(value => typeof value !== "string" || value.includes("\0"))) {
            throw new Error("Spawn argv must contain a non-empty executable and NUL-free strings.");
        }
        return [...options.argv];
    }
    return [validateLegacyCommand(options.command)];
}
function validateLegacyCommand(command) {
    if (!command || /[\0\r\n;&|`$()<>{}]/.test(command)) {
        throw new Error("Legacy spawn command contains unsupported shell syntax; use argv instead.");
    }
    return command;
}
function validateSpawnOptions(options) {
    if (!options.cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(options.cwd)) {
        throw new Error(`Spawn cwd must be absolute: ${options.cwd}`);
    }
    validatedEnv(options);
    spawnArgv(options);
}
function shellCommand(options) {
    validateSpawnOptions(options);
    const command = options.argv ? options.argv.map(shellQuote).join(" ") : options.command;
    const env = validatedEnv(options).map(([key, value]) => options.argv ? shellQuote(`${key}=${value}`) : `${key}=${value}`);
    return env.length > 0 ? `env ${env.join(" ")} ${command}` : command;
}
function powershellCommand(options) {
    validateSpawnOptions(options);
    const env = validatedEnv(options)
        .map(([key, value]) => `$env:${key} = ${powershellQuote(value)}`)
        .join("; ");
    const argv = options.argv ? `& ${options.argv.map(powershellQuote).join(" ")}` : options.command;
    return `${env ? `${env}; ` : ""}Set-Location -LiteralPath ${powershellQuote(options.cwd)}; ${argv}`;
}
