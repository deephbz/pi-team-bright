# Graph-native real Team E2E result

Date: 2026-08-13
Stage: hardening
Task: `ptb-graph-native-next-zss`
Result: graph control and real Worker flow passed; two integration defects remain

## Exact source and isolation

The real run used integrated commit
`84c9c89bec5bc40d94e3975b1347778d29a3c13b`, followed by the focused pane
transport repair at `2612fc999eb63c2ac4e1a0bcdb0c425e6051979e`.

The coordinator started through `_codex_with_proxy` with
`openai-codex/gpt-5.6-terra:medium`. It proved the presence of `HTTPS_PROXY`,
`ALL_PROXY`, and `NO_PROXY` without recording values. Its isolated
`PI_CODING_AGENT_DIR` had `packages: []`, and Pi loaded only the explicit
integrated extension. The visible product surface included `task_graph_apply`.

The first non-isolated attempt loaded the ambient HyperCarrier package and did
not expose `task_graph_apply`. A second exact-source attempt still inherited
that ambient package in Worker processes and failed `ensure_worker` twice with
Herdr `agent_name_not_found`. Both disposable Teams shut down without Tasks.
The fully isolated run then created Team `graph-native-e2e-20260813` and real
Terra-medium Workers `builder`, `verifier`, and `observer`.

## Functional graph result

The first complete graph applied at version `g_4f8386b74bad3a50`.
`build` began ready while `criterion` and `join` were dependency-waiting.
The first Worker-authored launch signal was `builder` claiming `build@1`.

The planned failed criterion traversed its bounded failure edge once. It
reactivated `build`, which achieved on `build@2`. `criterion` then achieved on
`criterion@2` with capable alias resolution. The join achieved on `join@1` with
input lineage `{build: build@2, criterion: criterion@2}`.

Alias resolution was exact per Attempt:

- `default` resolved to `openai-codex/gpt-5.6-terra:medium`;
- `capable` resolved to `openai-codex/gpt-5.6-terra:high`.

Revision `g_f95f5537e0a745c7` retained the three accepted Attempts and added
`audit@1` with input `{join: join@1}`. After an exact `worker_stop`, the same
logical `observer` Worker was created again. Revision `g_b195eb0304dbd6a5`
then completed `recovered@1` with input `{audit: audit@1}`. This is a
Worker-authored recovery result, not only carrier liveness.

`team_sync` projected all semantic transitions, but several bounded waits
returned `indeterminate` because Worker run-state evidence was incomplete. A
later update always exposed the committed Task transition.

## Live pane and performance

The live pane initially failed with `Herdr returned malformed JSON`. Installed
Herdr `pane run` returns status zero with empty stdout, but the pane host tried
to parse it as a JSON envelope. Commit `2612fc9` treats this command as the
fire-and-forget transport it is. Seven focused lifecycle tests and typecheck
passed after the repair.

With the fix active, direct Herdr panes reported:

- `Task graph ready · graph-native-e2e-20260813 · 5 tasks`;
- `Task graph ready · graph-native-e2e-20260813 · 20 tasks` for four islands;
- `Task graph ready · graph-native-e2e-20260813 · 40 tasks` for eight islands.

Every split used the exact leader origin and no focus. Each owned pane was
closed by exact ID. The integration worktree had stale `node_modules` without
the lockfile-declared `@dagrejs/dagre`; live pane checks and the benchmark used
a temporary symlink to the dependency already installed in the pane worktree,
then removed it.

The 15-iteration benchmark measured disconnected five-Task islands:

- 20 Tasks, 4 islands: layout p50 2.190 ms and p95 2.681 ms; viewport p95
  0.052 ms; canvas 168 by 56.
- 100 Tasks, 20 islands: layout p50 12.749 ms and p95 15.194 ms; viewport p95
  0.032 ms; canvas 211 by 230.
- 500 Tasks, 100 islands: layout p50 61.025 ms and p95 63.244 ms; viewport p95
  0.063 ms; canvas 211 by 1158.

The raw benchmark remains outside Git at
`/tmp/ptb-graph-e2e-isolated.xirG64/receipts/task-graph-benchmark.json`, with
SHA-256 `493bece0615e39368252248251f2eb6765ada32a443253d17b54dd921dd5f1b4`.
The machine E2E summary in the same directory has SHA-256
`3e2ebc45cae5057f1790b702b08a1f0faaa41b8b29c412c305e022dec2da4e7f`.

## Remaining defects

Graph revision replaces the complete graph. When the 20/40-Task pane graphs
intervened, reapplying the old five definitions could not retain their earlier
lineages. The cleanup revision therefore produced new Attempts. This is correct
for the immediate-prior semantic-lineage rule, but it means revision is not an
arbitrary historical restore operation.

A more serious integration defect remains. Coordination retained events for
Tasks removed by complete graph replacement. `team_sync` tried to hydrate those
IDs from current graph authority and returned `task_authority_unavailable` when
no current Task existed. Workers also received stale ready snapshots for
removed pane Tasks, then correctly got `task_not_found` on claim. Direct
`task_read` remained coherent and enabled cleanup.

Cleanup completed the fresh lineage as `build@3`, `criterion@3`, `join@2`,
`audit@2`, and `recovered@2`. All three exact Workers stopped. Team shutdown
returned `unfinished_task_ids: []`.

No push, tag, publication, registry mutation, or aggregate test ran.
