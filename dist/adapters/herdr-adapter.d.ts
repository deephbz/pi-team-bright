import { TerminalAdapter, SpawnOptions } from "../utils/terminal-adapter";
/** Herdr names are lowercase identifiers with a fixed 32-character limit. */
export declare function herdrCarrierName(teamName: string | undefined, workerName: string): string;
/** Herdr terminal-surface implementation; it never shells a teammate argv. */
export declare class HerdrAdapter implements TerminalAdapter {
    readonly name = "herdr";
    currentTargetId(): string | null;
    renamePane(paneId: string, label: string): void;
    /**
     * Herdr identity may be inherited by an inner tmux server. That preserves
     * surface discovery but does not make tmux a valid carrier for a Herdr Team.
     */
    isDirectCarrier(): boolean;
    detect(): boolean;
    private invoke;
    private paneRecord;
    private paneLayout;
    private rectFor;
    private assertWorkerRegion;
    private firstWorkerLeaderShare;
    /** Choose the largest viable registered Worker pane from the live Herdr layout. */
    private adaptiveSplit;
    spawn(options: SpawnOptions): string;
    /** Create location only. The caller records it before it starts Pi. */
    private splitArgs;
    prepareSpawn(options: SpawnOptions): string;
    private invokeAsync;
    /** Snapshot placement asynchronously; geometry uses the same algorithm as legacy callers. */
    prepareSpawnAsync(options: SpawnOptions, deadline?: number): Promise<string>;
    startPrepared(paneId: string, options: SpawnOptions): Promise<{
        state: "started" | "refused" | "unknown";
        fact: string;
    }>;
    private startOnce;
    kill(paneId: string): void;
    isAlive(paneId: string): boolean;
    setTitle(_title: string): void;
    supportsWindows(): boolean;
    spawnWindow(_options: SpawnOptions): string;
    setWindowTitle(_windowId: string, _title: string): void;
    killWindow(_windowId: string): void;
    isWindowAlive(_windowId: string): boolean;
}
