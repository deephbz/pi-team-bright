# Lead ownership and sync verification

## Result

**Accepted.** The packaged skill contains the approved lead guidance. The apparent receipt conflict is only catalog metadata, not model-visible tool guidance.

## Checks

- **Lead responsibility: pass.** `skills/pi-team-bright/SKILL.md` assigns the lead both project ownership and coordination. It preserves user intent, constraints, approach, decomposition, evaluation, delegation accountability, assignment, supervision, blocker resolution, and escalation.
- **Mandatory sync: pass in the skill.** It defines in-flight work as assigned nonterminal Tasks, including waiting and blocked Tasks. It requires every interim user reply or progress note, including blocker escalation, to end with `team_sync({view:"updates"})`, then requires continued synchronization when work can progress.
- **Receipt rule: pass.** `src/model-tool-contract/catalog.ts` contains a `whenNotToUse` metadata sentence about not using sync immediately after a mutation receipt, but `src/model-tool-contract/pi-registration.ts` sets the registered description to `teamSyncCatalogEntry.responsibility` only. The `whenNotToUse` array is not model-visible. The registered responsibility is the whole-Team snapshot/update description, so it does not contradict the skill's required sync after an interim message. The skill and runtime were not edited.
- **Task and Alert separation: pass.** The skill routes assignment and definition changes through `task_graph_apply`, keeps context updates separate, and limits Alerts to exceptional clarification or attention. The catalog says Alerts never change Task state, and the Worker prompt repeats that boundary.
- **Blocked and indeterminate behavior: pass.** The skill treats blocked Tasks as unfinished, requires blocker and next actor evidence, treats `indeterminate` as incomplete observation evidence, and avoids identical empty sync loops. `observation-service.ts` returns `indeterminate` when Worker run-state evidence remains incomplete after the bounded wait, without publishing an observation. The sync nudge path also suppresses uncertain debt rather than inventing state.
- **Nudge distinction: pass.** `sync-nudge-conductor.ts` uses a delayed, event-driven reminder only after the lead is settled and not busy. `sync-nudge.ts` presents a custom message that asks for `team_sync`; it does not mutate a Task or send an Alert. The default delay is 1,200 seconds in `sync-liveness-settings.ts`, so it cannot replace active supervision.
- **Links: pass.** Both links in the packaged skill resolve: `references/team-rescue.md` and `../../docs/reference.md`.
- **Applicable probes: pass.** Ran `node -r ts-node/register/transpile-only docs/journal/artifacts/2026-09-13-skill-interface-probe.cjs`; it confirmed stable-key revision preservation, context-only updates, bounded repair routing, and new identity after key rename. Source inspection confirms the registered description path above. A focused existing surface test captured registration but failed only on its stale assertion for the removed old skill sentence (`For a new Team, call team_create before the first team_sync`); it did not report a registered-description conflict. No broad suite ran.

## Residual uncertainty

Source review proves wording and runtime branches, not model compliance or end-to-end liveness. Residual uncertainty is limited to model compliance and end-to-end liveness.

## Correction and final conformance assessment

The earlier conflict claim was incorrect. The catalog's `whenNotToUse` sentence is documentation metadata. The registered tool exposes only `teamSyncCatalogEntry.responsibility`, as shown in `src/model-tool-contract/pi-registration.ts`; it does not expose that metadata. The lead's follow-up narrowed that sentence as documentation-only coherence: do not call sync only to recheck the lead's own receipt, but continue required updates supervision while Tasks remain in flight. No runtime or schema change was required. The skill, registered responsibility, Worker prompt, sync result paths, and delayed nudge behavior conform to the accepted guidance.

## Final skill-surface check

The final diff removes only brittle assertions that required exact skill prose. It keeps executable registration assertions for the nine tools, `team_sync` parameters and description, Worker transition schema, Task update coordinates, Team placement boundaries, stable Worker identity, Alert schema, and removal of alternate tools. The catalog edit changes only descriptive `whenNotToUse` metadata; registration still exposes `teamSyncCatalogEntry.responsibility` only.

The required command was attempted once from the package root:

```text
node_modules/.bin/vitest run --config vitest.full.config.ts src/utils/tool-surface.test.ts
```

It could not start because this package has no `node_modules/.bin/vitest` (`exit 127`). A Vitest binary exists in the repository root, but the Task required the package-local command, so no substitute run was made. Reused prior graph, link, and source evidence remains valid because the skill and runtime behavior are unchanged.

Final tested source hashes:

- `skills/pi-team-bright/SKILL.md`: `e995b5fce1ae7b9b5095f020fb790ae8dc04e72b15f50914d1e990b540c41f50`
- `src/model-tool-contract/catalog.ts`: `21ed00a3711ed89466db2b462b9bd7c020c4ed5be7ba1ebfcb786c65f936b591`
- `src/utils/tool-surface.test.ts`: `34079b037aafa4c8c9c5fe278cda5a363420e985ea9a8963b1176794426cdc63`
- `src/model-tool-contract/pi-registration.ts`: `c3cf3ff9075c9a03e3bb77ab0bd880d2eaae62d3cb6b33bb5cbd9f12fc8cf049`
- `extensions/pi-team-session-adapter.ts`: `f6b2cf901159aed62f8a6b28edbadcbdc8b49002db5acdda1bf8d9810f4425d7`
- `src/coordination/observation-service.ts`: `bd65d19b6b1b8a4ff54bf70398f882f015543e541eae6592f5a4e6dc3dfb3822`
- `src/utils/sync-nudge-conductor.ts`: `05a7801977be7b4e1d639cc79a644c418a4d54c37aca1c03b5f94aae060f10`
- `src/utils/sync-nudge.ts`: `4e19ea5b7cee202ba97f1968688a5c1fdb0e80e6952ac37d9d94de4b00aa8b61`
- `docs/journal/artifacts/2026-09-13-skill-interface-probe.cjs`: `b6e441f8af4f48a56d1571882162a502e94660dc304ba02f0c2bb88fbe612248`

Final assessment: source review passes. The only material verification limitation is the missing package-local Vitest executable; no implementation or skill blocker was found.

## Focused surface test completion

The runner-path blocker was resolved without installation. From the package root, this required command ran once:

```text
../../node_modules/.bin/vitest run --config vitest.full.config.ts src/utils/tool-surface.test.ts
```

Result: **pass**, 1 test file and 9 tests passed. The final source hashes above remain the tested hashes. The test confirms that the brittle skill-prose assertions were removed while executable registration coverage remains. The catalog `whenNotToUse` edit remains descriptive metadata only; the registered `team_sync` responsibility is unchanged. No broad or full suite ran, and no implementation or skill files were edited.

Final assessment: source review and focused tool-surface verification pass. No blocker remains.
