import { Type, type Static } from "typebox";
import { type GraphTaskCard } from "./graph-control-schemas";
/** Neutral Task contract. This module imports no authority or persistence code. */
export declare const TASK_CARD_TITLE_MAX_LENGTH = 80;
export declare const TASK_CARD_GOAL_MAX_LENGTH = 1000;
export declare const TASK_CARD_CONTEXT_MAX_LENGTH = 2000;
export declare const TaskCardStatusSchema: Type.TEnum<["open", "in_progress", "blocked", "closed"]>;
export declare const TaskCardContextSchema: Type.TString;
export declare const TaskCardWarningSchema: Type.TObject<{
    task_id: Type.TString;
    truncated_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
    incomplete_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
    message: Type.TString;
}>;
export declare const TaskDependencyRelationSchema: Type.TObject<{
    relation: Type.TEnum<["blocked_by", "parent", "related"]>;
    target_task_id: Type.TString;
}>;
export declare const TaskDependencyStateSchema: Type.TUnion<[Type.TObject<{
    kind: Type.TLiteral<"ready">;
    active_blocker_ids: Type.TArray<Type.TString>;
}>, Type.TObject<{
    kind: Type.TLiteral<"waiting">;
    active_blocker_ids: Type.TArray<Type.TString>;
}>, Type.TObject<{
    kind: Type.TLiteral<"terminal">;
    active_blocker_ids: Type.TArray<Type.TString>;
}>]>;
export declare const TaskCardCompleteSchema: Type.TObject<{
    goal: Type.TString;
    projection_warnings: Type.TOptional<Type.TArray<Type.TObject<{
        task_id: Type.TString;
        truncated_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
        incomplete_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
        message: Type.TString;
    }>>>;
    id: Type.TString;
    title: Type.TString;
    status: Type.TEnum<["open", "in_progress", "blocked", "closed"]>;
    assignee: Type.TOptional<Type.TString>;
    relations: Type.TOptional<Type.TArray<Type.TObject<{
        relation: Type.TEnum<["blocked_by", "parent", "related"]>;
        target_task_id: Type.TString;
    }>>>;
    dependency_state: Type.TOptional<Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"ready">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"waiting">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"terminal">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>]>>;
    current_context: Type.TString;
    version: Type.TString;
}>;
export declare const TaskCardIncompleteSchema: Type.TObject<{
    goal_state: Type.TLiteral<"incomplete">;
    projection_warnings: Type.TArray<Type.TObject<{
        task_id: Type.TString;
        truncated_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
        incomplete_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
        message: Type.TString;
    }>>;
    id: Type.TString;
    title: Type.TString;
    status: Type.TEnum<["open", "in_progress", "blocked", "closed"]>;
    assignee: Type.TOptional<Type.TString>;
    relations: Type.TOptional<Type.TArray<Type.TObject<{
        relation: Type.TEnum<["blocked_by", "parent", "related"]>;
        target_task_id: Type.TString;
    }>>>;
    dependency_state: Type.TOptional<Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"ready">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"waiting">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"terminal">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>]>>;
    current_context: Type.TString;
    version: Type.TString;
}>;
/**
 * Delivery and Coordination accept legacy cards during cutover, while the
 * graph-native Task application writes GraphTaskCard only.
 */
export declare const TaskCardSchema: Type.TUnion<[Type.TObject<{
    goal: Type.TString;
    projection_warnings: Type.TOptional<Type.TArray<Type.TObject<{
        task_id: Type.TString;
        truncated_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
        incomplete_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
        message: Type.TString;
    }>>>;
    id: Type.TString;
    title: Type.TString;
    status: Type.TEnum<["open", "in_progress", "blocked", "closed"]>;
    assignee: Type.TOptional<Type.TString>;
    relations: Type.TOptional<Type.TArray<Type.TObject<{
        relation: Type.TEnum<["blocked_by", "parent", "related"]>;
        target_task_id: Type.TString;
    }>>>;
    dependency_state: Type.TOptional<Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"ready">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"waiting">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"terminal">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>]>>;
    current_context: Type.TString;
    version: Type.TString;
}>, Type.TObject<{
    goal_state: Type.TLiteral<"incomplete">;
    projection_warnings: Type.TArray<Type.TObject<{
        task_id: Type.TString;
        truncated_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
        incomplete_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
        message: Type.TString;
    }>>;
    id: Type.TString;
    title: Type.TString;
    status: Type.TEnum<["open", "in_progress", "blocked", "closed"]>;
    assignee: Type.TOptional<Type.TString>;
    relations: Type.TOptional<Type.TArray<Type.TObject<{
        relation: Type.TEnum<["blocked_by", "parent", "related"]>;
        target_task_id: Type.TString;
    }>>>;
    dependency_state: Type.TOptional<Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"ready">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"waiting">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"terminal">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>]>>;
    current_context: Type.TString;
    version: Type.TString;
}>, Type.TObject<{
    id: Type.TString;
    title: Type.TString;
    goal: Type.TString;
    assignee: Type.TString;
    model: Type.TEnum<["default", "capable"]>;
    needs: Type.TArray<Type.TString>;
    on_goal_failed: Type.TOptional<Type.TObject<{
        target: Type.TString;
        max_traversals: Type.TInteger;
    }>>;
    status: Type.TEnum<["dependency_waiting", "ready", "in_progress", "blocked", "goal_failed", "goal_achieved", "cancelled"]>;
    state: Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"dependency_waiting">;
        prerequisite_task_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"ready">;
    }>, Type.TObject<{
        kind: Type.TLiteral<"in_progress">;
        attempt_id: Type.TString;
    }>, Type.TObject<{
        kind: Type.TLiteral<"blocked">;
        attempt_id: Type.TString;
        evidence: Type.TString;
    }>, Type.TObject<{
        kind: Type.TLiteral<"goal_achieved">;
        attempt_id: Type.TString;
    }>, Type.TObject<{
        kind: Type.TLiteral<"goal_failed">;
        reason: Type.TLiteral<"criterion_failed">;
        attempt_id: Type.TString;
    }>, Type.TObject<{
        kind: Type.TLiteral<"goal_failed">;
        reason: Type.TLiteral<"failure_edge_exhausted">;
        attempt_id: Type.TString;
        target_task_id: Type.TString;
        traversals: Type.TInteger;
        exhaustion_reason: Type.TEnum<["limit_reached", "target_cancelled"]>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"goal_failed">;
        reason: Type.TEnum<["dependency_failed", "dependency_cancelled"]>;
        prerequisite_task_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"cancelled">;
        reason: Type.TString;
    }>]>;
    current_context: Type.TString;
    version: Type.TString;
    activation_key: Type.TOptional<Type.TString>;
    accepted_attempt_id: Type.TOptional<Type.TString>;
    current_attempt: Type.TOptional<Type.TObject<{
        id: Type.TString;
        ordinal: Type.TInteger;
        resolved_model: Type.TString;
        input_attempt_ids: Type.TRecord<"^.*$", Type.TString>;
    }>>;
    attempts_started: Type.TInteger;
    relations: Type.TOptional<Type.TArray<Type.TObject<{
        relation: Type.TEnum<["blocked_by", "parent", "related"]>;
        target_task_id: Type.TString;
    }>>>;
    dependency_state: Type.TOptional<Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"ready">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"waiting">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"terminal">;
        active_blocker_ids: Type.TArray<Type.TString>;
    }>]>>;
    projection_warnings: Type.TOptional<Type.TArray<Type.TObject<{
        task_id: Type.TString;
        truncated_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
        incomplete_fields: Type.TArray<Type.TEnum<["title", "goal", "current_context"]>>;
        message: Type.TString;
    }>>>;
}>]>;
export declare function isTaskCardContext(value: unknown): value is string;
export declare function isTaskCardGoal(value: unknown): value is string;
export type TaskCardWarning = {
    task_id: string;
    truncated_fields: Array<"title" | "goal" | "current_context">;
    incomplete_fields: Array<"title" | "goal" | "current_context">;
    message: string;
};
/** DAG fields are optional only for stored pre-DAG cards during migration. */
export type LegacyTaskCard = Static<typeof TaskCardCompleteSchema> | Static<typeof TaskCardIncompleteSchema>;
/** Historical source alias retained for legacy Beads consumers. */
export type TaskCard = LegacyTaskCard;
/** Current delivery and observation boundary during graph cutover. */
export type CanonicalTaskCard = LegacyTaskCard | GraphTaskCard;
export declare function isGraphTaskCard(task: CanonicalTaskCard): task is GraphTaskCard;
/** Terminal means no more assigned work can run without a graph revision. */
export declare function isTaskTerminal(task: CanonicalTaskCard): boolean;
