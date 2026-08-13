# Fresh transition-replay runtime receipt

Date: 2026-08-13
Task: `ptb-graph-native-next-1j7`
Verifier consumer: `ptb-graph-native-next-6i4`
Target source: `59d08d6e4828ca71c844402744481b15602c51ea`
Architecture impact: none

## Result

A fresh isolated real Team passed the graph replay-after-transition scenario on
exact target source. No implementation changed.

The coordinator ran through `_codex_with_proxy` with
`openai-codex/gpt-5.6-terra:medium`, `packages: []`, the exact integrated
extension, and explicit Worker default `openai-codex/gpt-5.6-terra`. Its
preflight proved `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` names present. It
also proved the exact branch and HEAD, isolated Pi root, provider, model,
reasoning level, Worker default, and visible `task_graph_apply` tool. No proxy
or credential value was recorded.

## Real Team evidence

Team `graph-transition-replay-fresh-20260813` created connected Worker
`builder`. Operation `X` applied one Task, `keep`, at graph
`g_b89b5c7ba89f60d7`. The Task started ready at
`v_1758aee96f72360c`.

The Worker authored claim operation
`fresh-transition-replay-probe-claim-001`. It advanced `keep` to in-progress
`v_f0bb693522cb5230`, with Attempt `keep@1` resolved to
`openai-codex/gpt-5.6-terra`.

The leader then sent the byte-identical operation `X`. It returned
`replayed: true`, had no `delivery_warnings`, and retained exact in-progress
version `v_f0bb693522cb5230`. The observed authority sequence after that replay
was 3. The leader advanced only current context to `replay-one-passed`, which
produced `v_4a83a962aa64a6f2` and let the Worker finish.

The Worker authored result operation
`fresh-transition-replay-probe-achieved-001` with evidence exactly
`fresh runtime replay passed`. It advanced `keep` to `goal_achieved` at
`v_7f3e387162ec1244`. Authority sequence was 5 before the second replay.

The second byte-identical operation `X` returned `replayed: true`, had no
`delivery_warnings`, and retained exact goal-achieved version
`v_7f3e387162ec1244`. Authority sequence remained 5 after replay. The final
trace contains one graph revision at sequence 1 and Task events at sequences
2 through 5, so neither replay added or rolled back authority state.

`team_sync` returned coherent `caught_up` at head 8.

## Bound graph pane and cleanup

The exact coordinator command opened a bound pane in the same Herdr tab. Exact
pane `w4:p1D8` reported
`Task graph ready · graph-transition-replay-fresh-20260813 · 1 tasks`. Its
visible current-only projection showed one `goal_achieved` Task, the fresh
probe, from graph-control authority at revision `8-a96ef59f1484767c`.

This worktree's stale `node_modules` still lacked declared
`@dagrejs/dagre@3.1.1`. A temporary untracked link supplied that same installed
dependency for the pane only. The same extension command closed exact pane
`w4:p1D8`; an exact read then returned `pane_not_found`. The temporary link was
removed.

A final Task read retained `goal_achieved` version
`v_7f3e387162ec1244`. Exact `worker_stop` returned `worker_stopped` for
`builder`. `team_shutdown` returned lifecycle `stopped` with
`unfinished_task_ids: []`.

## Boundaries

Raw native Session and extracted receipt files remain outside the repository at
`/tmp/ptb-transition-replay-runtime.WWZG45`. They are historical evidence, not
a second Task authority. No fallback Session, implementation change,
credential content read, credential or Team-storage edit, dependency install,
push, tag, publication, or registry mutation occurred.
