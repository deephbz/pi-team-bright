# Task update optional fields and version refs

Date: 2026-08-03

Task `ptb-tool-result-projection-review-dds` applies the accepted minimal Task-update ergonomics decision.

The public candidate update item keeps its batch shape, exact optimistic concurrency, and model-provided operation ID. `status`, `current_context`, and `journal_entries` are optional change fields, with object-level `minProperties: 4` requiring one. Omitted context preserves existing candidate metadata. Omitted journal entries append no note. Blocked and closed transitions still rely on the Task authority evidence guard.

`taskVersionRef()` is the pure model boundary: SHA-256 of the raw authority version, truncated to 16 lowercase hex characters and prefixed with `v_`. The authority shell compares the supplied ref to freshly read raw state, then passes the raw version to conditional mutation. Raw semantic details retain authority versions; model projection converts Task versions, conflict recovery versions, snapshots, updates, and links to refs.

Focused evidence: `npx vitest run src/model-tool-contract/task-update-version-ref.test.ts` passed in 439 ms. It validates optional update shapes, rejects no-op and raw-version model input, preserves omitted context, and projects the opaque ref.

Architecture impact: `none`. This changes an existing candidate tool contract and its projection boundary. It does not change component responsibility, trust boundaries, or topology.
