# Persisted 640-character `current_context` reproduction

Date: 2026-08-03
Task: `ptb-worker-alert-context-limit-82f`
Source tree: `7ccad1d1f7c1693822502e2aad7683b5fe981b52` plus the uncommitted model-tool integration tree.

## Question and boundary

This investigation concerns candidate model-tool `current_context`. It does not
add a generic Task-domain field. The persisted value is
`pi_teams_candidate_task.current_context` in Beads metadata. Native Task
`notes` is a different Beads field, although the Worker receipt adapter also
projects nonempty `notes` as `current_context`.

## Executable reproduction

A disposable Vitest file created a real temporary Git and Beads 1.1.0 authority.
It created a Beads Task through `BeadsTaskStore`, then used the owned `bd`
launcher as an external writer:

```text
npx vitest run src/model-tool-contract/context-limit-repro.test.ts
bd --directory <temporary-workspace> --json update <task-id> \
  --set-metadata pi_teams_candidate_task=<JSON with 641 ASCII x characters>
```

The test then read the same record through `BeadsTaskStore`,
`CandidateBeadsTaskAdapter`, `DurableModelToolTeamPort`, and the real model-tool
executors. It removed its temporary authority and test file after the run.

Observed result:

```text
Test Files  1 passed (1)
Tests       1 passed (1)
```

The assertions proved all of the following.

- The external Beads command persisted all 641 ASCII characters in
  `pi_teams_candidate_task` metadata.
- `readCandidateTaskAuthorityRecord` read that value. The candidate adapter
  parsed and returned it as a `found` Task.
- The raw `task_read` executor result contained the 641-character Task but
  failed `CandidateTaskReadResultSchema`. Its normal assembly threw
  `Invalid semantic result for task_read.` before model content existed.
- A raw Team snapshot contained the same Task but failed
  `CandidateTeamSyncResultSchema`.
- After a clean snapshot baseline, both `team_sync` `updates` and `snapshot`
  threw `Invalid semantic result for team_sync.`. The sync executor invokes
  `projectCandidateToolResult` before it sets the pending observation result,
  so no valid sync result is published.

This is a real Beads write path, not a mocked runner. The test used the owned
`@beads/bd` binary reported as `bd version 1.1.0 (8e4e59d39)`.

## Source trace

1. `MODEL_TOOL_CANDIDATE_LIMITS.maxTaskCurrentContextChars` is 640 and the
   candidate Task card, leader `task_update` parameter, and Task delta current
   schemas apply it ([`catalog.ts:12-15`, `catalog.ts:41-50`,
   `catalog.ts:149-154`, `catalog.ts:229-234`]). Thus a normal leader model
   call cannot submit 641 graphemes.
2. `CandidateTaskMetadata` declares `current_context: string` with no runtime
   bound ([`beads.ts:20-35`]). `BeadsTaskStore` serializes any supplied metadata
   directly into `bd update --set-metadata` ([`beads.ts:738-748`]).
3. Candidate metadata construction and Worker refresh copy the string without a
   bound ([`beads-task-adapter.ts:108-122`]). The parser only checks that the
   string is nonempty ([`beads-task-adapter.ts:149-218`]); it then projects the
   same string into the Task card ([`beads-task-adapter.ts:221-230`]).
4. The candidate update path constructs `nextMetadata` and sends it to the
   generic Task mutation unchanged ([`beads-task-adapter.ts:290-356`]).
5. A model-tool Worker accepts unbounded `append_note`, then, when the Worker
   marker is set, uses that complete note as refreshed candidate
   `current_context` ([`extensions/index.ts:2297-2345`]). This is an owned
   persisted overflow path, not only an external-writer path.
6. Normal Worker receipts have a second overflow path: `workerTaskCard` maps
   unbounded native `notes` to `current_context`
   ([`extensions/index.ts:356-393`]). Any large native note can therefore fail
   the Worker candidate-result assembly.
7. The durable port reads each candidate Task without a length guard
   ([`durable-model-tool-port.ts:512-523`]) and passes its current state through
   snapshot and updates projection ([`durable-model-tool-port.ts:235-247`,
   `durable-model-tool-port.ts:536-574`]).
8. `task_read` creates the raw semantic result without validation
   ([`executors.ts:129-157`]); normal Pi registration then calls
   `assembleCandidateToolResult`, whose raw validation rejects it. For
   `team_sync`, the executor itself calls `projectCandidateToolResult` before
   return ([`executors.ts:324-375`]), so it throws earlier.
9. Raw semantic schemas reject the Task card at 640
   ([`catalog.ts:48`, `catalog.ts:233`]); model-result projection repeats the
   640 bound in its separate `TaskCard` schema
   ([`result-projection.ts:41-49`]). The repeat is a downstream safety check,
   not a persistence guard.

## Length unit

`typebox@1.1.38` measures `minLength` and `maxLength` in grapheme clusters,
not UTF-16 code units or Unicode code points. Its implementation states this
and uses `NextGraphemeClusterIndex` ([`node_modules/typebox/build/guard/string.mjs:120-132`]).
A direct check gave these results:

```json
{"name":"641 ASCII","utf16":641,"codePoints":641,"check":false}
{"name":"640 family graphemes","utf16":7040,"codePoints":4480,"check":true}
{"name":"641 family graphemes","utf16":7051,"codePoints":4487,"check":false}
```

Any repair that uses JavaScript `string.length` will silently change the
contract for multi-code-unit graphemes.

## Facts and inference

Facts:

- 640 appears only in candidate model-tool schemas and result projections. The
  generic `TaskFile` has no `current_context` field.
- An external Beads writer and the marked Worker `append_note` route can persist
  more than 640 graphemes in candidate metadata.
- The current reader admits those records, then later raw/model validation
  turns them into thrown execution errors rather than a typed semantic result.
- Native notes have no limit and can independently overflow the Worker receipt
  projection.

Inference:

- 640 is a model-projection and candidate-metadata contract budget, not a
  generic Task-domain invariant. Beads must retain arbitrary native Task notes
  and external metadata. The candidate adapter must enforce its own persisted
  projection contract and fail safely on foreign records.

## Smallest repair option

Put one grapheme-aware candidate-metadata validator at the metadata boundary.
It must use the same 640-grapheme rule as TypeBox. Apply it before every owned
candidate metadata write, including `candidateMetadata`, Worker refresh, and
`BeadsTaskStore` when `candidateTaskMetadata` is supplied. Reuse that validator
in `parseCandidateTaskMetadata`.

For a legacy or external record above the budget, return the existing typed
`candidate_metadata_invalid` contract gap from `task_read` and `team_sync`. Do
not truncate, rewrite, or infer a replacement context. The raw authority
record remains evidence. An operator or an explicit repair mutation must write
a valid candidate value before model projection resumes.

Also decide the separate Worker-native-note policy. Either bound the
`workerTaskCard` projection with a typed contract gap/compact summary, or stop
using full native `notes` as model `current_context`. Do not silently truncate
native evidence.

## Independently testable repair criteria

1. 640 grapheme clusters pass and 641 fail on the candidate write path.
2. A 640-family-emoji string passes even though its UTF-16 length exceeds 640.
3. A marked Worker `task_update` with a 641-grapheme `append_note` refuses
   before its Beads mutation; no candidate metadata changes.
4. Direct `BeadsTaskStore` candidate metadata writes reject 641 graphemes.
5. A manually seeded 641-grapheme external record makes `task_read`, snapshot,
   and updates return `candidate_metadata_invalid`; none throws during raw,
   model, or TUI projection.
6. A valid external metadata repair restores `task_read` and `team_sync`.
7. Large native notes follow the selected explicit Worker policy and cannot
   cause an invalid candidate tool result.
