import type { ExecResult } from "../env/host-env";
export type HerdrEnvelope = {
    result?: unknown;
    error?: {
        code?: unknown;
        message?: unknown;
    };
};
/** Only a structured Herdr error proves a refusal such as pane_not_found. */
export declare class HerdrRequestError extends Error {
    readonly code: string;
    readonly fact: string;
    constructor(error: NonNullable<HerdrEnvelope["error"]>);
}
/** Herdr sends errors on stderr. Nonempty stdout remains authoritative. */
export declare function readHerdrEnvelope(response: Pick<ExecResult, "stdout" | "stderr">): HerdrEnvelope;
export declare function herdrResult(envelope: HerdrEnvelope): Record<string, unknown>;
export declare function readHerdrReply(response: ExecResult): Record<string, unknown>;
