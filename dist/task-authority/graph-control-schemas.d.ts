import { Type, type Static } from "typebox";
export declare const GraphVersionRefSchema: Type.TString;
export declare const GraphControlModelAliasSchema: Type.TEnum<["default", "capable"]>;
export declare const GraphTaskTransitionSchema: Type.TEnum<["claim", "block", "resume", "goal_achieved", "goal_failed", "cancel"]>;
export declare const GraphFailureEdgeSchema: Type.TObject<{
    target: Type.TString;
    max_traversals: Type.TInteger;
}>;
export declare const GraphTaskStateSchema: Type.TUnion<[Type.TObject<{
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
export declare const GraphAttemptSummarySchema: Type.TObject<{
    id: Type.TString;
    ordinal: Type.TInteger;
    resolved_model: Type.TString;
    input_attempt_ids: Type.TRecord<"^.*$", Type.TString>;
}>;
/** Canonical graph-native Task card used by tools, delivery, and Coordination. */
export declare const GraphTaskCardSchema: Type.TObject<{
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
}>;
/** Breaking replacement for task_create. It applies one complete graph revision. */
export declare const TaskGraphApplyParametersSchema: Type.TObject<{
    operation_id: Type.TString;
    expected_graph_version: Type.TOptional<Type.TString>;
    tasks: Type.TArray<Type.TObject<{
        key: Type.TString;
        title: Type.TString;
        goal: Type.TString;
        assignee: Type.TString;
        model: Type.TOptional<Type.TEnum<["default", "capable"]>>;
        needs: Type.TOptional<Type.TArray<Type.TString>>;
        on_goal_failed: Type.TOptional<Type.TObject<{
            target: Type.TString;
            max_traversals: Type.TInteger;
        }>>;
    }>>;
}>;
/** One graph-native Task command. Waiting and ready are derived, never authored. */
export declare const GraphTaskUpdateParametersSchema: Type.TObject<{
    task_id: Type.TString;
    operation_id: Type.TString;
    expected_version: Type.TString;
    transition: Type.TOptional<Type.TEnum<["claim", "block", "resume", "goal_achieved", "goal_failed", "cancel"]>>;
    current_context: Type.TOptional<Type.TString>;
    evidence: Type.TOptional<Type.TString>;
}>;
export type GraphTaskCard = Static<typeof GraphTaskCardSchema>;
export type GraphTaskStateCard = Static<typeof GraphTaskStateSchema>;
export type TaskGraphApplyParameters = Static<typeof TaskGraphApplyParametersSchema>;
export type GraphTaskUpdateParameters = Static<typeof GraphTaskUpdateParametersSchema>;
