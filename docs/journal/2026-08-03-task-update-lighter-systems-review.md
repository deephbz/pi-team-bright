# Systems review: lighter `task_update`

Date: 2026-08-03
Task: `ptb-tool-result-projection-review-51a`

## Strongest claim

The proposal has a good boundary: a pure change-to-mutation/event core and an imperative authority shell. A discriminated change union can reduce ambiguous status combinations. Pi `toolCallId` is useful invocation provenance, but it is not sufficient as the durable idempotency key.

A crash can commit the Task before the receipt reaches the Session. A retry can create a new tool call ID for the same intent. Reusing the new ID can apply the mutation twice; deduplicating by an inferred fingerprint can collapse two intentional identical updates. Keep a model-supplied stable mutation or retry key, or prove a stronger runtime and authority guarantee.

## Smallest deep module interface

The deep module should accept one typed intent and current authority coordinates, then return a mutation plan or a typed refusal:

```ts
type TaskChange =
  | { kind: "start"; current_context: string; evidence: TaskEvidence[] }
  | { kind: "progress"; current_context: string; evidence: TaskEvidence[] }
  | { kind: "block"; current_context: string; evidence: TaskEvidence[] }
  | { kind: "complete"; current_context: string; evidence: TaskEvidence[] };

type TaskUpdateIntent = {
  task_id: TaskId;
  expected_version: TaskVersion;
  mutation_id: string; // stable across an intentional retry
  change: TaskChange;
};

planTaskUpdate(current: CurrentTask, intent: TaskUpdateIntent):
  | { kind: "mutation"; task: TaskMutation; event: StructuredTaskEvent }
  | { kind: "refused"; reason: "stale_version" | "operation_conflict" | "invalid_transition"; current: CurrentTask };
```

The shell supplies the Pi call ID as trace/receipt provenance, reads the authority, and commits the Task, replay record, and structured event in one authority transaction. It must not invent context or evidence text. A batch maps each item independently but commits each item atomically; duplicate Task IDs remain a whole-call refusal.

## Information classes

`current_context` is the bounded, replaceable current projection. Keep it model-supplied and require it for every change that changes work state; otherwise the Task can retain stale context. Journal evidence is append-only historical evidence. Keep evidence text and semantic kind model-supplied, while the shell assigns authoritative actor, timestamp, and journal/event IDs. `block` requires blocker evidence, `complete` requires result or verification evidence, and `start`/`progress` require progress evidence.

The four proposed variants omit resume/unblock and explicit open-state edits. Either define `progress` with an explicit target status or add `resume`; do not let the shell infer a transition from the current status. Decide whether closed Tasks can reopen. The current contract has four statuses, so the union must cover the allowed transition graph.

## Evidence and pushback

Current source proves the risk. `src/model-tool-contract/catalog.ts:145-188` requires model `operation_id`, exact `expected_version`, replacement `current_context`, and nonempty journal input. `src/model-tool-contract/pi-registration.ts:201-207` currently drops the Pi tool-call ID before task-update execution. `src/model-tool-contract/beads-task-adapter.ts:286-337` replays only a matching stored operation ID and fingerprint. `src/utils/beads.ts:661-669` states that Beads 1.1.0 has no true conditional write, while `src/utils/tasks.ts:203-282` publishes structured events after the Task write. Therefore the proposed shell cannot claim crash-safe atomic Task/event/replay semantics without a new authority capability.

Do not replace `operation_id` with `toolCallId` unless the runtime guarantees stable IDs across retry, crash recovery, provider replay, and Session resume. Do not infer idempotency from `(task_id, expected_version, change)`; identical valid updates can be intentional separate operations. Do not hide model context or evidence behind the shell. Do not add a second outbox or receipt store without an explicit authority decision.

## Provider and adapter impact

A TypeBox discriminated union is consistent with the current catalog, but generated provider schemas need tests for nested unions, required discriminants, `additionalProperties: false`, and batch item validation. Runtime validation remains authoritative if a provider weakens JSON Schema handling.

The change affects the catalog parameter schema, result schema, executor, `ModelToolTaskUpdateInput`, in-memory operation replay, `CandidateBeadsTaskAdapter`, durable preview port, Pi registration, TUI recovery text, and QA fixtures. The adapter must preserve per-item mutation IDs, exact versions, evidence, and partial batch outcomes. The existing Beads adapter should continue to fail closed until compare-and-swap plus Task-scoped replay are atomic.

## Reversal evidence

The `toolCallId` conclusion can reverse only after an integration test proves that Pi keeps the same ID across a provider retry, process crash after authority commit, Session resume, and receipt replay, while the authority atomically deduplicates the same ID and still permits two identical intents with distinct IDs. A runtime contract or authority transaction with those guarantees is required; a type declaration alone is not enough.
