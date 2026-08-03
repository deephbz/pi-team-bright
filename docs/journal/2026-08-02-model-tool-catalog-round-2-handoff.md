# Model-tool catalog round 2 handoff

Date: 2026-08-02

Status: active shaping implementation interrupted by native compaction. This is
continuation context, not an accepted contract.

## Owner decisions to preserve

- Design from scratch without backward compatibility, while retaining the
  high-level capabilities: Team creation, Alert communication, Task
  notification/update, Worker ensure/spawn, and Worker/Team shutdown.
- A Team and its leader are long-lived. Workers are relatively short-lived and
  own one semantically deep area with high cohesion, low prerequisite overlap,
  and few cross-Worker dependencies.
- `team_sync` and `ensure_worker` are the first two weight-bearing model calls.
- Leader calls resolve the one active Team from exact Session binding. They do
  not accept `team_name`.
- `team_sync({view:"snapshot"})` is the explicit snapshot call. The prior HTML
  incorrectly showed `updates` in the snapshot scenario.
- Raw semantic results have JSON Schema. Actual model content is a deterministic
  dense projection of the raw JSON that is lossless/isomorphic and reduces
  tokens.
- Task state is simpler: `title`, one `goal` containing outcome/boundary/success
  signal, workflow state, assignee, concise current context, and version. Do not
  split goal into scope and success-criteria fields.
- Keep the accepted starting field budgets: title 80 characters, goal 160, and
  current context 640.
- Do not impose candidate count limits on Workers, nonterminal Tasks, or journal
  entries. Do not introduce paging.
- Remove journal-summary limits and omission/paging concepts. Incremental Task
  deltas carry the new journal entries plus latest current state.
- A short shipped skill remains useful for cross-tool tactics. It should advise
  deep semantic Worker scopes, low context overlap, high concurrency, Tasks as
  work authority, snapshot recovery, update supervision, and exceptional
  Alerts. It must not copy exact parameter schemas.
- Snapshot plus batch Task drill-in is the recovery path if hidden observation
  state ever diverges from model-visible context. Future Task create/read/update
  operations must support batches to avoid one-call-per-Task waste. Multi-Task
  requests need not imply one cross-Task transaction.
- The owner explicitly requested no Playwright or dev-browser review. Ask the
  owner to open and assess the generated HTML directly.

## Work completed before compaction

- The first candidate catalog and HTML generator existed and passed typecheck,
  three focused tests, deterministic generation, and static HTML checks.
- YAML scope/responsibility front matter exists on:
  - `docs/projects/model-invoked-tool-contract.md`
  - `docs/projects/task-engine-performance.md`
  - `<home>/repos/HyperCarrier/docs/current/hc-team-orchestration.md`
- `src/model-tool-contract/catalog.ts` was rewritten for round 2 with:
  - `team_sync({view:"snapshot"|"updates"})`, no `team_name`;
  - `ensure_worker({name,scope})`;
  - Worker scope in snapshots and changes;
  - Task `title`, `goal`, and `current_context` only;
  - no Worker/Task/journal count limits;
  - full journal entries in Task deltas;
  - corrected snapshot scenario call;
  - three scenarios: deep Worker scope, compaction snapshot, routine updates.
- `src/model-tool-contract/dense-projection.ts` was added. It encodes candidate
  results as compact positional JSON tuples and decodes them back to validated
  raw semantic JSON for `team_sync` and `ensure_worker`.
- `src/model-tool-contract/render-review-html.ts` was rewritten to display both
  tools, scenario-first review, compact actual return, collapsible raw JSON,
  projection legend, and only the accepted Task field budgets.

## Unfinished work; do this next

1. Do not assume the rewritten round-2 code compiles yet. No inspection or
   verification occurred after the renderer rewrite because compaction began.
2. Rewrite `src/model-tool-contract/catalog.test.ts`; it is still the round-1
   test and incorrectly expects `team_name`, one tool, old fields, and old HTML.
   Add projection round-trip tests for every example and scenario.
3. Run typecheck and focused tests. Fix catalog, dense-projection, and renderer
   type errors only; do not touch unrelated Worker-resource work.
4. Regenerate `docs/generated/model-tool-contract-review.html` with
   `npm run docs:model-tools`, verify deterministic output, and run static HTML
   anchor/content checks. Do not use a browser automation tool.
5. Update `docs/projects/model-invoked-tool-contract.md` to replace stale round-1
   content with the owner decisions above. Make `team_sync` and `ensure_worker`
   co-central, remove `team_name`, remove Task scope/success-criteria fields and
   all entity/journal count-limit or paging language, add dense isomorphic
   result projection, long-lived Team/leader plus shorter-lived deep Workers,
   batch Task CRUD, and the short-skill tactical boundary.
6. Update the canonical starting topology in
   `<home>/repos/HyperCarrier/docs/current/hc-team-orchestration.md` so Team
   and leader are long-lived while Workers are shorter-lived deep-area units;
   keep Worker identity distinct from its replaceable carrier.
7. Align `docs/current/README.md` and
   `docs/projects/task-engine-performance.md` with no domain count caps/paging
   and the two-call catalog review.
8. Ask the owner to preview
   `docs/generated/model-tool-contract-review.html` directly and answer the
   scenario questions. Stop before implementation cutover.

## Known verification context

Before round-2 edits, `npm run typecheck`, the focused catalog tests, HTML static
validation, and deterministic generation passed. `npm run test:lanes` was
blocked by the unrelated unclassified
`src/utils/worker-resource-extension.contract.test.ts`; do not repair that as
part of this work.

Architecture impact remains none while the catalog is candidate-only and not
registered with Pi.
