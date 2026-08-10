import { Type } from "typebox";
export type TaskVersionRef = `v_${string}`;
export declare const TaskVersionRefSchema: Type.TString;
/** Stable model-facing version token. Authority versions never leave the shell. */
export declare function taskVersionRef(sourceRevision: string): TaskVersionRef;
