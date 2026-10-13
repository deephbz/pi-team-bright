export interface RecipientDeliveryBinding {
    teamName: string;
    recipient: string;
    membershipId: string;
    sessionFile: string;
}
export type DeliveryEngineName = "alert" | "task";
export type DeliveryOperation = "start" | "context" | "acknowledgement" | "scan";
export interface DeliveryDegradation {
    engine: DeliveryEngineName;
    operation: DeliveryOperation;
    message: string;
    observedAt: number;
    retryAt: number;
}
export type DeliveryEngineState = {
    state: "running";
    observedAt: number;
} | ({
    state: "degraded";
} & DeliveryDegradation);
export interface RecipientDeliveryEngine {
    start(): Promise<void>;
    stop(): void;
    observeContext(messages: readonly unknown[]): Promise<number>;
    commitPresentedAfterSuccessfulTurn(reason: unknown): Promise<number>;
}
export interface RecipientDeliveryPair {
    direct: RecipientDeliveryEngine;
    task: RecipientDeliveryEngine;
}
/** One exact recipient fence; each delivery engine owns an independent failure and retry. */
export declare class RecipientDeliveryLifecycle {
    private readonly dependencies;
    private active;
    constructor(dependencies: {
        makePair(binding: RecipientDeliveryBinding, failed: (engine: DeliveryEngineName, error: unknown) => void): RecipientDeliveryPair;
        isCurrentBinding(binding: RecipientDeliveryBinding): Promise<boolean>;
        publishState?(binding: RecipientDeliveryBinding, engine: DeliveryEngineName, state: DeliveryEngineState): Promise<void>;
    });
    get binding(): RecipientDeliveryBinding | undefined;
    activate(binding: RecipientDeliveryBinding): Promise<void>;
    deactivate(): void;
    observeContext(messages: readonly unknown[]): Promise<void>;
    commitPresentedAfterSuccessfulTurn(reason: unknown): Promise<void>;
    private current;
    private start;
    private forward;
    private fail;
    private stop;
    private publish;
}
