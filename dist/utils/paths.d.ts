export declare const PI_DIR: string;
export declare const TEAMS_DIR: string;
export declare const TASKS_DIR: string;
export declare function ensureDirs(): void;
export declare function sanitizeName(name: string): string;
export declare function teamDir(teamName: string): string;
export declare function taskDir(teamName: string): string;
export declare function inboxPath(teamName: string, agentName: string): string;
/** Task-authority-local delivery evidence for one resolved recipient. */
export declare function taskDeliveryPath(teamName: string, agentName: string): string;
export declare function taskDeliveryTombstonePath(teamName: string, agentName: string): string;
export declare function taskDeliveryRecoveryPath(teamName: string): string;
/** Durable adapter intent for Task ownership-change delivery recovery. */
export declare function taskOwnerTransitionOutboxPath(teamName: string): string;
/** Append-only, Team-scoped coordination evidence consumed by team_sync. */
export declare function teamEventJournalPath(teamName: string): string;
/** Disposable latest-cursor projection; the append-only journal remains authoritative. */
export declare function teamEventCursorStatePath(teamName: string): string;
export declare function runtimeStatusPath(teamName: string, agentName: string): string;
export declare function configPath(teamName: string): string;
export declare function leadSessionPath(teamName: string): string;
