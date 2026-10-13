import { type GenerationProbe } from "./env/host-env";
import type { Member, TerminalTarget } from "./team-authority/contracts";
import { type AgentRuntimeStatus, type RuntimeGeneration } from "./utils/runtime";
export type LaunchState = "none" | "requested" | "started" | "refused" | "unknown";
export type ProcessState = "live" | "stopping" | "gone" | "unknown" | "none";
export type NextActionHint = "ensure_worker" | "ask_human" | "wait";
export interface CarrierAttention {
    reason: "legacy_unverified";
    nextActionHint: "ask_human";
    message: string;
}
/** Herdr completion ends a turn, not the Worker process or its Task. */
export declare function herdrAgentActivity(status: unknown): CarrierView["activity"];
/** A PID probe cannot verify a legacy generation, but it can guide human repair. */
export declare function legacyCarrierAttention(member: Pick<Member, "name" | "membershipId" | "sessionFile">, status: AgentRuntimeStatus | null, probe: GenerationProbe): CarrierAttention | undefined;
export interface CarrierView {
    worker: string;
    membership: string;
    launchId?: string;
    generation?: RuntimeGeneration;
    binding: "unbound" | "bound";
    sessionFile?: string;
    launch: LaunchState;
    process: ProcessState;
    terminal: "present" | "absent" | "unknown";
    activity: "working" | "idle" | "blocked" | "unknown";
    attention?: CarrierAttention;
    lastStop?: AgentRuntimeStatus["lastStop"];
    paneId?: string;
    terminalTarget?: TerminalTarget;
    evidence: Array<{
        source: string;
        fact: string;
        observedAt: number;
        lastGoodAt?: number;
        expiresAt?: number;
    }>;
}
export interface CarrierEvent {
    membership: string;
    launchId?: string;
    generation?: RuntimeGeneration;
    field: "binding" | "launch" | "process" | "terminal" | "activity" | "blocked";
    from: string;
    to: string;
    cause: {
        source: string;
        fact: string;
    };
    observedAt: number;
    paneId?: string;
    terminalTarget?: TerminalTarget;
    suspectedHumanStop: boolean;
    nextActionHint: NextActionHint;
    attention?: CarrierAttention;
}
export declare function deriveCarrierView(member: Member, status: AgentRuntimeStatus | null, now?: number, observed?: GenerationProbe): CarrierView;
/** One in-flight bounded read per source. Invalid or partial responses never prove absence. */
export declare function herdrList(source: "agent" | "pane"): Promise<Record<string, unknown>[] | undefined>;
/** Ephemeral projection. It owns observations, never Membership or Task transitions. */
export declare const CARRIER_SAMPLE_TTL_MS = 6000;
export declare const LAUNCH_STALL_MS = 15000;
/** Recovery retains the Session; a successor generation completes its outstanding launch. */
export declare function launchIsOutstanding(member: Member, status: AgentRuntimeStatus | null): boolean;
export declare function launchIsStalled(member: Member, status: AgentRuntimeStatus | null, agents: readonly Record<string, unknown>[] | undefined, now?: number): boolean;
export declare class CarrierObserver {
    private readonly teamName;
    private readonly notify;
    private readonly projection;
    get views(): ReadonlyMap<string, CarrierView>;
    private readonly sourceReads;
    private expire;
    private sample;
    private timer?;
    private stopped;
    private inFlight?;
    private outage;
    private lastGood;
    private readonly publication;
    private journal;
    private blocked;
    constructor(teamName: string, notify?: (text: string) => void);
    start(): void;
    stop(): void;
    private tick;
    refresh(): Promise<void>;
    private collect;
    private publish;
}
/** Publish verified predecessor death before admission can overwrite its runtime record.
 * The admission caller holds the Membership lease through publication and replacement.
 */
export declare function publishPredecessorExit(teamName: string, member: Member, status: AgentRuntimeStatus, teamBackend?: string): Promise<void>;
