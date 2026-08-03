# Tool-result projection review continuation

Date: 2026-08-03
Status: shaping review in progress; no implementation authorized or started
Stage: Pi Team Bright surface is hardening/sharing; this result-projection correction is in consolidation before implementation

## Owner request and evidence

The owner supplied a real TUI transcript from a ten-tool `0.17.0-rc.1` smoke run and asked to assess every tool-call return for:

1. unnecessary information sent to the LLM; and
2. a more concise, intuitive human TUI projection.

The run covered `team_create`, `team_sync`, `ensure_worker`, batched `task_create`/`task_read`/`task_update`, `task_link`, `alert_send`, `worker_stop`, and `team_shutdown`.

Important observed symptoms:

- Every expanded tool result repeats the exact agent JSON under `Hints sent to agent`, then recursively dumps the same object as `Post-state`.
- Every candidate result ends with `Legacy result adapted; versioned envelope unavailable.`
- Candidate Task batches render as one `unknown · unassigned` Task.
- Candidate `team_sync` snapshots and gaps can render misleading `0 Workers` / `0 Tasks` facts.
- Semantic refusals render with a success check and `Accepted` because the renderer does not classify candidate union discriminants.
- Alert success can display `Accepted by: none` while the semantic result names accepted recipients.
- Shutdown can display zero stopped/unfinished counts while the semantic result contains nonempty arrays.
- The run produced repeated `team_sync` `contract_gap` results for `structured_task_event_evidence_absent`. This is a functional event-evidence problem, not only presentation noise.
- The `WebSocket error` after a tool call is provider transport evidence and must remain separate from the tool’s semantic result.
- The batched `task_update` version conflicts were correct optimistic-concurrency refusals because the Worker changed Tasks between the leader’s read and update. The projection should make reconciliation clear rather than hide or relabel these conflicts.

A source-controlled QA artifact already exists at `artifacts/tool-result-qa/latest.json`. It contains 39 result cases with agent, machine, compact-human, and expanded-human projections. It reproduces the same renderer defects. Do not treat some old cursor-shaped QA calls as the current public input contract; the owner’s real transcript is the runtime anchor.

## Exact owning mismatch

`src/model-tool-contract/result-projection.ts` validates each candidate semantic union, then returns that same object as both minified JSON `content` and raw `details`.

`src/utils/tool-result-renderer.ts` recognizes only `details.schema === "pi-teams-tool-result/1"` as current. Raw candidate unions fall into the generic legacy adapter. That adapter expects old scalar `task`/`postState` shapes and cannot understand candidate batches or candidate outcome discriminants.

All ten candidate registrations in `src/model-tool-contract/pi-registration.ts` attach this shared renderer, so this is one assembly/projection-boundary defect, not ten independent renderer bugs.

## Current assessment

The public semantic unions remain the authoritative operation results. One result must have three explicit projections:

- agent content: only facts that can change the next reasoning step;
- machine details: complete versioned semantic result plus evidence/diagnostics for reconstruction;
- human TUI: concise collapsed result and a deliberate expanded view.

Do not fix this with ten unrelated renderers or by teaching the generic legacy adapter more accidental shapes.

Preferred coherent direction:

1. Add an explicit versioned candidate machine envelope at the assembly boundary. It should contain `schema`, `operation`, and one typed `semanticResult`, with separate optional evidence/diagnostics. Do not force the semantic result into legacy `postState`.
2. Avoid a second generic outcome vocabulary when the semantic union already owns `team_created`, `refused`, `unavailable`, `contract_gap`, `cancelled`, `partial`, and other distinctions. Human tone and labels should derive from the semantic discriminant. Thrown execution/provider errors remain Pi error paths, not synthetic semantic refusals.
3. Support resumed history in this detection order: new versioned candidate envelope; old `/1` envelope; schema-validated raw candidate result; generic legacy result; plain execution-error fallback.
4. Stop showing exact agent content in the normal human expanded view. It is duplicate when machine semantic details are present. If exact projection comparison is needed, keep it in trace/QA evidence rather than ordinary TUI output.
5. Render expanded semantic details once. Keep machine-only identities and private paths behind allowlist redaction.
6. Add table-driven assembly and renderer tests for every union variant across all ten tools, plus resumed-session compatibility fixtures and a real restarted TUI check.

A meaningful schema change should use a new machine-envelope version rather than silently redefining `/1`. This recommendation still needs owner ratification.

## Agent-content reduction by result family

- `team_create` success: retain created kind, Team identity, and lifecycle. Purpose repeats the call and can be machine-only unless normalized output differs. Refusal/unavailable must retain reason and actionable message.
- `ensure_worker` success: retain Worker name, effect, and carrier. Scope repeats the call. Refusal retains existing scope; unavailable retains reason/message.
- `task_create` success: retain ordered input index, Task ID, status/assignee, and version. Title, goal, and initial context repeat the call. Refused/unavailable items retain index, reason, and actionable message.
- `task_read`: keep the complete Task card because retrieval is the operation. Keep ordered found/missing/contract-gap outcomes. Avoid duplicate `task_id` presentation when `task.id` already identifies the same Task.
- `task_update` success: retain index, Task/operation IDs, new version, status, and the post-state coordinates needed for another write. The submitted context and journal text usually repeat the call; journal IDs/timestamps/actor are machine evidence. On version or operation conflict, keep the complete current Task because it determines whether to retry, accept Worker progress, or stop.
- `team_sync` snapshot: keep the complete bounded Team/Worker/Task orientation. Updates keep grouped deltas, new journal evidence, latest current Task state, and Alerts. `contract_gap`, `unavailable`, `cancelled`, and `snapshot_required` must show their reason and explicitly say that observation did not advance; never show entity counts for these variants.
- `task_link`: retain source, relation, target, action, changed/no-op, and returned version. Refusal retains conflict reason and recovery message.
- `alert_send`: retain accepted and failed recipients plus Task reference when relevant. Opaque Alert ID and invariant `task_state_changed:false` can stay machine-side. Refusal must say not sent; partial fan-out must name failed recipients.
- `worker_stop`: retain stopped/not-stopped, Worker, and guarding Task IDs. Do not repeat generic `No Task state changed` as the main fact.
- `team_shutdown`: retain lifecycle, stopped/failed Workers, and unfinished Task IDs. Partial must say the Team remains active.

Do not remove required `message` fields until structured reason/recovery coordinates independently carry the actionable meaning.

## Human default/expanded hierarchy

Collapsed output should contain one semantic headline and only decisive facts or warnings. Examples:

- `✓ Team created · tool-smoke-…`
- `✓ Worker created · tool-smoke-worker · connected`
- `✓ 3/3 Tasks created`
- `✓ 3/3 Tasks found`
- `! 0/3 Tasks updated · 3 stale versions`
- `✓ Related task A → B`
- `✗ Alert refused · announcements require to: "*"`
- `! Announcement accepted by 1/2 · failed: delivery-broken`
- `✗ Worker not stopped · 2 nonterminal Tasks`
- `! Team remains active · stopped 2 · failed 1 · 4 unfinished Tasks`
- `✗ Sync contract gap · event 6 lacks structured Task evidence · observation unchanged`

Expanded output should add a purpose-built list/card projection, not recursive key dumping:

- batches: one compact row per input/outcome;
- Task reads/snapshots: title/status/assignee first, goal/context/version below;
- conflicts: current version and current Task state, with a clear retry/reconcile action;
- shutdown/Alert partials: named successes and failures;
- trace-only machine evidence remains outside ordinary expansion.

## Independent observer reviews

PiTeams Team: `ptb-tool-result-projection-review`.

Both assigned observer Tasks are closed:

- Product: `ptb-tool-result-projection-review-q78`
- Systems: `ptb-tool-result-projection-review-1ha`

Product observer strongest claim: candidate semantic JSON is a valid baseline agent projection, but the human renderer’s legacy route fabricates plausible false summaries. Collapsed output should be one outcome/identity line plus decisive facts. Expanded output should show semantic evidence once.

Systems observer strongest claim: the smallest owning invariant is candidate result assembly. Add an explicit machine semantic-result slot/envelope, preserve semantic refusal/gap/unavailable distinctions, and test old envelopes/raw candidates/generic legacy history separately.

Shared observer question for the owner: ratify a new explicit candidate semantic-result envelope and remove raw agent JSON from ordinary expanded TUI output, or prefer an additive `/1` field and a trace-only content section?

## Owner learning gate

Before implementation, ask the owner for a teach-back or counterexample:

- Which exact result should still show the full agent JSON in the ordinary expanded TUI, and what operator decision would it improve?
- For a successful Task mutation, which echoed input field changes the model’s next action enough to justify repeated context?

Recommended decision: new machine envelope version, compact agent projections, no agent-content echo in ordinary TUI expansion, and explicit per-union human formatters behind one shared dispatch boundary.

## Remaining work

1. Present this assessment and the observer pushback to the owner.
2. Get owner ratification on the envelope/version and expanded-view decisions.
3. Investigate the real `structured_task_event_evidence_absent` event as a separate functional defect. Preserve its raw Team event evidence before changing it.
4. If implementation is authorized, create separate implementation and independent verification Tasks. Keep product and systems observers non-implementing.
5. Implement at the assembly/projection boundary, not as symptom patches.
6. Verify every semantic union, privacy redaction, resumed history, provider-content equality, and a restarted TUI at narrow and normal widths.
7. Update the generic HyperCarrier interaction guide only with ratified reusable rules. Keep exact Pi Team Bright schemas in executable child contracts.
8. Reconcile and shut down Team `ptb-tool-result-projection-review` only after this review round is complete.

Architecture impact if implemented: changed at the public model/machine/human projection contract. No new component, authority, store, process, trust, or deployment boundary is proposed.

## 2026-08-03 systems observation after cutover

The implementation Task `ptb-tool-result-projection-review-gye` closed with a focused gate: `npm run typecheck` and four projection/catalog/registration test files passed. The systems review then found unresolved cutover defects.

Current evidence: `src/model-tool-contract/result-projection.ts` is now the raw semantic validator and model projector; `src/model-tool-contract/tui-projection.ts` is the TUI adapter; `extensions/index.ts` wraps Worker receipts through `projectWorkerReceipt`; `src/utils/receipt-types.ts` remains an internal legacy-shell receipt envelope. The old renderer and `src/utils/tool-results.ts` are deleted. The checked-out QA artifact remains schema `/1` and was not regenerated.

Unresolved findings: Worker receipt adaptation fabricates or collapses semantics. It maps every refused Worker Task update to `version_conflict`, synthesizes a journal entry on success, and maps partial Alert delivery to success with no failures (`extensions/index.ts:365-390`). The model schema leaves `team_sync` update arrays as `Type.Unknown()` (`src/model-tool-contract/result-projection.ts`), and model projection removes observation-unchanged fields for sync failures. Batch Task-update TUI output does not surface per-item recovery hints. `task_link` conflicts still lack current Task/version recovery. `tui-projection.ts` derives human output from the model projection rather than directly from raw semantic truth. `render-review-html.ts`, `scripts/probe-model-tool-vertical-slice.ts`, `scripts/model-tool-canary/run.mjs`, and QA suite compatibility branches retain stale identity/schema assumptions.

Task state: systems observation `ptb-tool-result-projection-review-ajv` is blocked pending these corrections or explicit owner acceptance of the gaps. Do not run the release lane. Resume with focused source review and ask the implementer to preserve exact Worker outcome categories, typed sync/update projections, batch recovery display, current Task/version conflict coordinates, regenerated QA evidence, and stale-reference purge.
