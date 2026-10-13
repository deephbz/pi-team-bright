"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HerdrRequestError = void 0;
exports.readHerdrEnvelope = readHerdrEnvelope;
exports.herdrResult = herdrResult;
exports.readHerdrReply = readHerdrReply;
/** Only a structured Herdr error proves a refusal such as pane_not_found. */
class HerdrRequestError extends Error {
    code;
    fact;
    constructor(error) {
        const code = typeof error.code === "string" ? error.code : "unknown_error";
        const message = typeof error.message === "string" ? error.message : "Herdr returned an invalid error response";
        const fact = `${code}: ${message}`;
        super(`Herdr request failed: ${fact}`);
        this.name = "HerdrRequestError";
        this.code = code;
        this.fact = fact;
    }
}
exports.HerdrRequestError = HerdrRequestError;
/** Herdr sends errors on stderr. Nonempty stdout remains authoritative. */
function readHerdrEnvelope(response) {
    let parsed;
    try {
        parsed = JSON.parse(response.stdout.trim() ? response.stdout : response.stderr);
    }
    catch {
        throw new Error("Herdr returned malformed JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Herdr returned an invalid JSON envelope.");
    }
    return parsed;
}
function herdrResult(envelope) {
    if (envelope.error)
        throw new HerdrRequestError(envelope.error);
    const result = envelope.result ?? envelope;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Herdr returned a response without an object result.");
    }
    return result;
}
function readHerdrReply(response) {
    const result = herdrResult(readHerdrEnvelope(response));
    if (response.status !== 0) {
        throw new Error(`Herdr command failed with status ${response.status}: ${response.stderr || "unknown error"}`);
    }
    return result;
}
