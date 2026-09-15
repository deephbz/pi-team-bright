# Worker model profiles

Status: complete and independently verified; unreleased
Stage: hardening
Base: `9f5bffd02c2c3f92260f54b805fa225ef2cb1c0f`
Scope: one semantic change in the Pi Team Bright child repository, prepared as
one owner-requested commit. No release, parent gitlink update, or
installed-settings change was performed.

[Decision 0014](../decisions/0014-worker-model-profiles.md) owns accepted intent.
[Independent verification](worker-model-profiles-verification.md) owns test,
package, real E2E, and final-delta evidence and its applicability limits.
Other pre-existing untracked journals and parent changes are unrelated.

## Outcome

The leader selects a configured model alias when creating a Worker. The Worker
retains its assignment across Tasks and carrier replacement. Same-Session
recovery preserves Pi's recorded model and thinking level, including human
overrides. Tasks have no model selector or independent model resolver.

Create and snapshot responses expose a compact alias catalog. Invalid selections
return valid choices before Worker creation. Worker summaries echo the alias.
Successful and failed TUI results include a settings hint; Ctrl+O shows one
configuration example. Human guidance stays out of model-facing JSON.

## Executable boundaries

- `src/utils/worker-resource-projection.ts` owns profile settings parsing and
  invocation-local model validation. Provider/model coordinates remain distinct.
- `src/team-authority/contracts.ts` and `worker-launch-bridge.ts` own the
  durable creation binding, prepared retry, and native same-Session continuation.
- `src/model-tool-contract/catalog.ts` and `result-projection.ts` own the tool
  and model-facing contracts. Coordination receives the bound leader's cwd and
  project trust for catalog restoration.
- `src/model-tool-contract/tui-projection.ts` and `tui-message-projection.ts`
  own collapsed/expanded human guidance. Task graph views omit retired model data.
- `src/task-authority/graph-control.ts` owns Task/Attempt scheduling and lineage.
  Old owned snapshots containing the removed model mechanism refuse without
  compatibility or migration.

## Verification summary

The equivalent full test configuration passed 1,042 tests with two skipped.
Independent final-delta checks cover trusted/untrusted catalog restoration,
prepared retry thinking, bound recovery, and negative evidence fixtures.
Typecheck, lane closure, agent-surface checks, and private-index package
verification passed. Git records the complete source and generated output in
one change.

The real isolated Team used Luna/low and Haiku/medium profiles. All three DAG
Tasks completed through Worker-authored transitions. A human-model override to
Fable/xhigh survived a new process bound to the same Session and Membership;
the post-recovery Task also completed. The strengthened receipt checker and
independent native-record inspection support these claims.

Private evidence remains at `/tmp/pi-team-bright-profile-e2e-20260915`, with
`receipt.json` locating native Sessions, tool results, Team/carrier records,
TUI exports, and cleanup evidence. Disposable test panes/processes, test Teams,
and the auth reference were cleaned. Existing coordination work was preserved.

Product and systems observers reviewed the implementation and the final fixes.
No implementation blocker remains. This evidence does not establish a published
release, parent integration, or availability of arbitrary model/provider pairs.

## Architecture impact

Changed within Pi Team Bright: model selection moved from Task aliases to
Worker configuration and native Session continuation. Child contracts and
persistence changed. HyperCarrier keeps these internals opaque; no depicted
component, provider boundary, store, process, or deployment surface changed.
The canonical Structurizr topology therefore remains unchanged.
