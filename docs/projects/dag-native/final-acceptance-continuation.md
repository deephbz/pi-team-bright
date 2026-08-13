# Final graph-native acceptance continuation

Updated: 2026-08-13
Task: `ptb-graph-native-next-5eg`
Task version at last accepted update: `v_2ced89ae6c052534`
Stage: hardening
Status: acceptance and release gates complete; final receipt commit remains

## Exact source and constraints

The acceptance runtime used exact clean source
`5653d3a0c0a9ce47f9b02142e2f137930bd3dfd1` on
`feature/dag-native-rc13`. Do not change implementation unless a remaining gate
finds a defect. Do not push, tag, publish, edit credentials or Team storage, use
a fallback Session, or mutate registry state.

## Completed real acceptance

The isolated proxy/Terra-medium Team
`graph-native-final-acceptance-20260813` passed on exact source with
`packages: []`, explicit Worker default `openai-codex/gpt-5.6-terra`, default
alias `openai-codex/gpt-5.6-terra:medium`, and capable alias
`openai-codex/gpt-5.6-terra:high`.

After graph v1 apply, the leader made zero `task_update` or `alert_send` calls.
Workers and mechanical dispatch produced `build@1` success,
`criterion@1` planned failure, one bounded repair traversal to `build`,
`build@2` success, `criterion@2` success, and success-only `join@1` with exact
lineage `{build: build@2, criterion: criterion@2}`. Sync caught up at head 27.

Graph versions were:

- v1 `g_277486b210010bb6`;
- v2 `g_54851941c2bfeffc`, adding achieved `audit@1` with input `join@1`;
- v3 `g_d0b0cf8c0eb1a120`, removing `criterion` and `join`, retaining `build`,
  changing `audit`, and adding `recovered`.

The same stable `observer` Worker stopped and reconnected. Removed reads returned
`task_not_found`. A deliberately non-identical v3 operation reuse refused
`operation_conflict` without state change. Correct byte-identical v3 replays
returned `replayed: true` without warnings and retained authority sequence 36.
Current IDs were exactly `build`, `audit`, and `recovered`, all achieved.
Immutable v1 history remained. Reconnected `observer` completed `audit@2` and
`recovered@1` with input `{audit: audit@2}`. Sync caught up at head 40.

The bound current-only pane `w4:p1DE` showed the three current v3 Tasks and then
closed exactly. Direct graph-control panes passed at 20, 100, and 500 Tasks;
owned panes `w4:p1DF`, `w4:p1DG`, and `w4:p1DH` all closed exactly. The valid
15-iteration benchmark measured layout p95 2.868, 14.343, and 63.725 ms for
20, 100, and 500 Tasks. Viewport p95 was 0.052, 0.034, and 0.067 ms. Benchmark
SHA-256 is
`32a90455889aa443c82154526d29e596be1311f65d6e2e0d10e12f2440bb05ee`.

Cleanup stopped `builder`, `verifier`, and reconnected `observer`. Final sync
contained only stop events. Shutdown returned lifecycle stopped and
`unfinished_task_ids: []`.

Raw evidence is outside Git at
`/tmp/ptb-final-graph-acceptance.riLK3D/receipts`.

## Final gate state

The initial receipt commit is
`3baeaee2243fdfba4fceaa418e5a59c05e24cdaf`. The broad `test:full` attempt
passed typecheck, then stopped at the stale `task_create` model-tool budget
assertion. The aggregate did not rerun. Focused repair
`2d88cd1feff6e1d2c85667c02c7013ecc78befeb` passed its exact 1/1 test.

`npm run test:lanes` passed with 138 tests: 115 fast and 23 exhaustive. The
package probe passed, then the generated-dist gate found output that had not
been refreshed for graph-native Task cards. Focused source-bundle repair
`23f20fc58adc3de859e3a5e50bee8ed4be7fa766` passed the final
`npm run verify:package` check.

The required full-history privacy scan rejected grandfathered pre-baseline
metadata and stopped after 100 findings without printing detected values. The
configured release range from baseline `8b6d82876a133e96ef8614ef2916e55d28b4ac03`
through `23f20fc` passed. All 25 post-baseline commits use the approved public
identity.

Only the final documentation append and clean-tree check remain. Commit this
file with the updated journal result, then confirm the final HEAD and clean
worktree. Do not rerun the real E2E, broad aggregate, or package lane for that
documentation-only commit.
