# Final graph-native acceptance E2E

Date: 2026-08-13
Task: `ptb-graph-native-next-5eg`
Runtime source: `5653d3a0c0a9ce47f9b02142e2f137930bd3dfd1`
Stage: hardening
Architecture impact: none

## Result

The repaired exact source passed the final real Team workflow, removal and
replay gates, Worker recovery, direct graph pane checks, and the bounded
20/100/500 layout benchmark. No implementation changed during this acceptance
run.

The isolated coordinator used `_codex_with_proxy`, Terra-medium,
`packages: []`, the exact integrated extension, explicit Worker default
`openai-codex/gpt-5.6-terra`, default alias
`openai-codex/gpt-5.6-terra:medium`, and capable alias
`openai-codex/gpt-5.6-terra:high`. Preflight proved the required proxy names,
exact branch and source, provider, model, reasoning level, isolated settings,
and nine-tool leader surface. It did not record proxy or credential values.

## Autonomous graph workflow

Team `graph-native-final-acceptance-20260813` created stable Workers `builder`,
`verifier`, and `observer`. Graph v1 was `g_277486b210010bb6`.

After the initial graph apply, the coordinator used no `task_update` or
`alert_send` calls. It observed progression through `team_sync`; Workers and
the mechanical ready front performed all Task handoffs:

- `build@1` achieved with the default alias;
- `criterion@1` failed as planned with the capable alias;
- its bounded failure edge traversed exactly once to `build`;
- `build@2` achieved;
- `criterion@2` achieved with input `{build: build@2}`;
- `join@1` achieved only after both current inputs succeeded, with exact input
  lineage `{build: build@2, criterion: criterion@2}`.

The accepted default Attempts resolved to
`openai-codex/gpt-5.6-terra:medium`. Both criterion Attempts resolved to
`openai-codex/gpt-5.6-terra:high`. `team_sync` reached `caught_up` at head 27.

## Revision, removal, replay, and recovery

Graph v2 `g_54851941c2bfeffc` retained accepted v1 lineage and added `audit`.
`audit@1` achieved with input `{join: join@1}`. The leader then stopped
`observer` and recreated the same stable Worker name and scope.

Graph v3 `g_d0b0cf8c0eb1a120` removed `criterion` and `join`, retained `build`,
changed `audit` to a root, and added `recovered` after it. Leader reads returned
`task_not_found` for both removed IDs while current reads stayed coherent.

One deliberately non-identical operation-ID reuse refused `operation_conflict`
and changed no state. The corrected byte-identical v3 replays returned
`replayed: true` without delivery warnings. The final replay retained current
versions and authority sequence 36. Current IDs were exactly `build`, `audit`,
and `recovered`; all were `goal_achieved`. Immutable history still contained
`build@2`, `criterion@2`, and `join@1`. Reconnected `observer` completed
`audit@2` and `recovered@1`; the latter used exact input
`{audit: audit@2}` and the default alias. `team_sync` reached `caught_up` at
head 40 without stale removed-Task hydration.

## Pane and performance evidence

The bound live pane opened from the exact Team leader and showed only the three
current v3 Tasks. Exact pane `w4:p1DE` reported
`Task graph ready · graph-native-final-acceptance-20260813 · 3 tasks` and showed
current graph-control revision 40 with `audit` and `recovered` achieved. The
same command closed it; exact lookup returned `pane_not_found`.

Three no-focus, exact-origin graph-control panes then passed:

- `final-pane-20`: 20 Tasks, four disconnected islands, 20 typed edges;
- `final-pane-100`: 100 Tasks, 20 islands, 100 typed edges;
- `final-pane-500`: 500 Tasks, 100 islands, 500 typed edges.

The visible 20- and 500-Task pages retained canonical ready/waiting states,
success routes, bounded failure routes, model detail, freshness, and island
navigation. All owned panes were closed by exact ID.

The 15-iteration benchmark measured:

- 20 Tasks: layout p95 2.868 ms; viewport p95 0.052 ms;
- 100 Tasks: layout p95 14.343 ms; viewport p95 0.034 ms;
- 500 Tasks: layout p95 63.725 ms; viewport p95 0.067 ms.

The 500-Task canvas remained 211 by 1158, so the accepted tall-canvas residual
and need for island navigation remain. These host measurements are calibration,
not public latency promises.

## Cleanup and source bundle

All current Tasks remained achieved. Exact stops succeeded for `builder`,
`verifier`, and the reconnected `observer`. The final sync contained only the
three stop events. Team shutdown returned lifecycle `stopped` with
`unfinished_task_ids: []`.

Raw native Sessions, extracted tool receipts, trace, pane sources, benchmark,
and checksums remain outside Git at
`/tmp/ptb-final-graph-acceptance.riLK3D/receipts`. The benchmark SHA-256 is
`32a90455889aa443c82154526d29e596be1311f65d6e2e0d10e12f2440bb05ee`.
They are historical evidence, not a second authority.

No fallback Session, credential content read, credential or Team-storage edit,
push, tag, publication, or registry mutation occurred.

## Final release gates

The runtime receipt was committed at
`3baeaee2243fdfba4fceaa418e5a59c05e24cdaf`. The one broad
`TERM_PROGRAM=iTerm.app npm run test:full` attempt ran on that exact tree.
Typecheck passed, then the exhaustive runner stopped at one stale
model-tool-budget assertion: it still expected removed `task_create` instead of
the accepted `task_graph_apply` tool. No runtime or graph correctness test
failed. Per the hardening protocol, the broad aggregate did not rerun.

Focused repair `2d88cd1feff6e1d2c85667c02c7013ecc78befeb` updates that gate to
check `task_graph_apply` and sets its compact provider-schema ceiling to 1,500
characters above the measured 1,465. Its exact focused Vitest passed 1/1.
`npm run test:lanes` then passed with 138 tests classified as 115 fast and 23
exhaustive.

The package gate's packed observation probe passed, then its generated-dist
check exposed stale graph-native Task-domain output. Focused source-bundle repair
`23f20fc58adc3de859e3a5e50bee8ed4be7fa766` adds the graph-control schemas to
the observation emit roots and refreshes the tracked output. The final
`npm run verify:package` passed: the packed observation probe passed and the
generated output matched Git.

The mandatory full-history privacy scan ran at `23f20fc`; it rejected inherited
pre-baseline history and stopped after 100 metadata findings without printing a
detected value. This is grandfathered location evidence, not a claim that old
history is public-safe. The configured release range from baseline
`8b6d82876a133e96ef8614ef2916e55d28b4ac03` through `23f20fc` passed the privacy
scanner. All 25 commits after the baseline use the approved public identity.

Release-gate logs remain with the raw acceptance bundle under
`/tmp/ptb-final-graph-acceptance.riLK3D/receipts/release-gates`. This final
receipt append is documentation-only, so the package lane did not rerun.
