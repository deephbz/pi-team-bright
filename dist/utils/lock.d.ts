export declare function withLock<T>(lockPath: string, fn: () => Promise<T>, retries?: number): Promise<T>;
/** Acquire several locks in a stable order so a composite write cannot leave
 * one side committed merely because the other side was missing. */
export declare function withLocks<T>(lockPaths: string[], fn: () => Promise<T>, retries?: number): Promise<T>;
