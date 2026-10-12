import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { TaskVersionRefSchema } from "./catalog";

export const WorkerAlertSendParametersSchema = Type.Object({
  kind: StringEnum(["clarification", "attention"]),
  text: Type.String(),
  task_id: Type.Optional(Type.String()),
  task_version: Type.Optional(TaskVersionRefSchema),
});

export const WorkerTaskReadParametersSchema = Type.Object({
  task_id: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
