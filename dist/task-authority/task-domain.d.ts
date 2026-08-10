import { Type, type Static } from "typebox";
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
    current_context: Type.TString;
    version: Type.TString;
}>;
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
    current_context: Type.TString;
    version: Type.TString;
}>]>;
export declare function isTaskCardContext(value: unknown): value is string;
export declare function isTaskCardGoal(value: unknown): value is string;
export type TaskCardWarning = {
    task_id: string;
    truncated_fields: Array<"title" | "goal" | "current_context">;
    incomplete_fields: Array<"title" | "goal" | "current_context">;
    message: string;
};
export type TaskCard = Static<typeof TaskCardCompleteSchema> | Static<typeof TaskCardIncompleteSchema>;
