export declare const OBSERVATION_SCHEMA: "pi-teams-observation/1";
export declare const OBSERVATION_SCHEMA_VERSION: 1;
export declare const OBSERVATION_PRODUCER_VERSION: string;
export type ObservationAvailability = "available" | "partial" | "unavailable";
export type SnapshotIssueCode = "teams_root_unavailable" | "projection_deadline_exceeded" | "projection_aborted";
export type TeamIssueCode = "team_unreadable" | "team_config_missing" | "team_config_malformed" | "membership_malformed" | "team_changed_during_read";
export type MembershipIssueCode = "membership_duplicate" | "session_locator_invalid" | "runtime_missing" | "runtime_malformed" | "runtime_legacy" | "runtime_generation_mismatch" | "runtime_unavailable" | "process_binding_ambiguous";
export type ObservationIssueCode = SnapshotIssueCode | TeamIssueCode | MembershipIssueCode;
export type ObservationIssue = {
    code: SnapshotIssueCode;
    scope: "snapshot";
} | {
    code: TeamIssueCode;
    scope: "team";
    teamName: string;
} | {
    code: MembershipIssueCode;
    scope: "membership";
    teamName: string;
    memberName: string;
    membershipId: string;
};
export interface MembershipObservation {
    membershipId: string;
    teamName: string;
    memberName: string;
    coordinationRole: "lead" | "teammate";
    lifecycle: {
        state: "current";
        joinedAt: string;
    } | {
        state: "ended";
        joinedAt: string;
        endedAt?: string;
        reason?: "team_shutdown" | "process_shutdown" | "replaced";
    };
    session?: {
        kind: "pi-jsonl-path";
        locator: string;
    };
    terminalTarget?: {
        backend: string;
        kind: "pane" | "window";
        targetId: string;
    };
    processBinding?: {
        membershipId: string;
        pid: number;
        processStartedAt: string;
    };
    /** Recorded readiness, not an liveness assertion. Present only with a valid exact generation. */
    readiness?: boolean;
    issues: ObservationIssue[];
}
export interface TeamObservation {
    teamName: string;
    memberships: MembershipObservation[];
    issues: ObservationIssue[];
}
export interface TeamObservationSnapshot {
    schema: typeof OBSERVATION_SCHEMA;
    generatedAt: string;
    producerVersion: string;
    availability: ObservationAvailability;
    teams: TeamObservation[];
    issues: ObservationIssue[];
}
/** Canonical JSON Schema for the local, evidence-only pi-teams-observation/1 wire record. */
export declare const observationJsonSchema: {
    readonly $schema: "https://json-schema.org/draft/2020-12/schema";
    readonly $id: "pi-teams-observation/1";
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["schema", "generatedAt", "producerVersion", "availability", "teams", "issues"];
    readonly properties: {
        readonly schema: {
            readonly const: "pi-teams-observation/1";
        };
        readonly generatedAt: {
            readonly type: "string";
            readonly format: "date-time";
        };
        readonly producerVersion: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly availability: {
            readonly enum: readonly ["available", "partial", "unavailable"];
        };
        readonly teams: {
            readonly type: "array";
            readonly items: {
                readonly $ref: "#/$defs/team";
            };
        };
        readonly issues: {
            readonly type: "array";
            readonly items: {
                readonly $ref: "#/$defs/issue";
            };
        };
    };
    readonly $defs: {
        readonly issue: {
            oneOf: ({
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    code: {
                        enum: string[];
                    };
                    scope: {
                        const: string;
                    };
                    teamName?: undefined;
                    memberName?: undefined;
                    membershipId?: undefined;
                };
            } | {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    code: {
                        enum: string[];
                    };
                    scope: {
                        const: string;
                    };
                    teamName: {
                        type: string;
                        minLength: number;
                    };
                    memberName?: undefined;
                    membershipId?: undefined;
                };
            } | {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    code: {
                        enum: ObservationIssueCode[];
                    };
                    scope: {
                        const: string;
                    };
                    teamName: {
                        type: string;
                        minLength: number;
                    };
                    memberName: {
                        type: string;
                        minLength: number;
                    };
                    membershipId: {
                        type: string;
                        minLength: number;
                    };
                };
            })[];
        };
        readonly terminalTarget: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["backend", "kind", "targetId"];
            readonly properties: {
                readonly backend: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly kind: {
                    readonly enum: readonly ["pane", "window"];
                };
                readonly targetId: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
            };
        };
        readonly lifecycle: {
            readonly oneOf: readonly [{
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["state", "joinedAt"];
                readonly properties: {
                    readonly state: {
                        readonly const: "current";
                    };
                    readonly joinedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                };
            }, {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["state", "joinedAt"];
                readonly properties: {
                    readonly state: {
                        readonly const: "ended";
                    };
                    readonly joinedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly endedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly reason: {
                        readonly enum: readonly ["team_shutdown", "process_shutdown", "replaced"];
                    };
                };
            }];
        };
        readonly session: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["kind", "locator"];
            readonly properties: {
                readonly kind: {
                    readonly const: "pi-jsonl-path";
                };
                readonly locator: {
                    readonly type: "string";
                    readonly minLength: 1;
                    readonly pattern: "^/";
                };
            };
        };
        readonly processBinding: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["membershipId", "pid", "processStartedAt"];
            readonly properties: {
                readonly membershipId: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly pid: {
                    readonly type: "integer";
                    readonly minimum: 2;
                };
                readonly processStartedAt: {
                    readonly type: "string";
                    readonly format: "date-time";
                };
            };
        };
        readonly membership: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["membershipId", "teamName", "memberName", "coordinationRole", "lifecycle", "issues"];
            readonly properties: {
                readonly membershipId: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly teamName: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly memberName: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly coordinationRole: {
                    readonly enum: readonly ["lead", "teammate"];
                };
                readonly lifecycle: {
                    readonly $ref: "#/$defs/lifecycle";
                };
                readonly session: {
                    readonly $ref: "#/$defs/session";
                };
                readonly terminalTarget: {
                    readonly $ref: "#/$defs/terminalTarget";
                };
                readonly processBinding: {
                    readonly $ref: "#/$defs/processBinding";
                };
                readonly readiness: {
                    readonly type: "boolean";
                };
                readonly issues: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/$defs/issue";
                    };
                };
            };
        };
        readonly team: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["teamName", "memberships", "issues"];
            readonly properties: {
                readonly teamName: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly memberships: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/$defs/membership";
                    };
                };
                readonly issues: {
                    readonly type: "array";
                    readonly items: {
                        readonly $ref: "#/$defs/issue";
                    };
                };
            };
        };
    };
};
export interface ReadObservationOptions {
    teamsRoot?: string;
    producerVersion?: string; /** Total projection budget; defaults to 1 second. */
    deadlineMs?: number;
    signal?: AbortSignal;
}
/** Lock-free, read-only evidence projection. Atomic producers provide old-or-new records. */
export declare function readObservationSnapshot(options?: ReadObservationOptions): Promise<TeamObservationSnapshot>;
