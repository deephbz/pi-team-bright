import type { GenerationProbe } from "./host-env";
export declare const MISSING_GENERATION_HELPER_MESSAGE = "The macOS process-generation helper is missing. Install Rust (rustc) and Xcode Command Line Tools, then run npm run build:process-generation in the installed @hypercarrier/pi-team-bright directory. Retry after the build.";
/** Field 22 follows a parenthesized comm which can itself contain spaces and ')'. */
export declare function linuxStartToken(stat: string): string | undefined;
/** A poll uses one bounded helper invocation for the whole Team. */
export declare function probeProcessGenerations(pids: readonly number[]): Promise<Map<number, GenerationProbe>>;
export declare function probeProcessGeneration(pid: number): GenerationProbe;
