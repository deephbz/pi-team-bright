import type { Member, TeamConfig, TerminalTarget } from "../team-authority/contracts";
/** Validate the persisted shape without inferring backend ownership from an ID. */
export declare function assertTerminalTargetShape(value: unknown, context: string): asserts value is TerminalTarget;
export declare function terminalTarget(backend: string, kind: TerminalTarget["kind"], targetId: string): TerminalTarget;
/**
 * Read a Member target. Legacy fields remain readable only when the Team or
 * caller already supplies the owning backend; target prefixes are never used
 * as backend evidence.
 */
export declare function memberTerminalTarget(member: Member, teamBackend?: string): TerminalTarget | undefined;
export declare function assertTeamTerminalTarget(config: TeamConfig, member: Member): TerminalTarget | undefined;
export declare function hasPersistedTerminalTarget(member: Member): boolean;
