export declare class LockDeadlineError extends Error {
    constructor();
}
/** One operation deadline covers nested authority locks. Late callbacks fail before mutation. */
export declare function withLockDeadline<T>(deadline: number, action: () => Promise<T>, signal?: AbortSignal): Promise<T>;
export declare function assertLockDeadline(): void;
/** Admission must not exit a live Worker due to lock contention. The launcher
 * owns its hang ceiling. Async scope also covers nested persistence locks. */
export declare function withUnboundedLockWait<T>(action: () => Promise<T>): Promise<T>;
export declare function withLock<T>(lockPath: string, fn: () => Promise<T>, retries?: number): Promise<T>;
/** Acquire several locks in a stable order so a composite write cannot leave
 * one side committed merely because the other side was missing. */
export declare function withLocks<T>(lockPaths: string[], fn: () => Promise<T>, retries?: number): Promise<T>;
