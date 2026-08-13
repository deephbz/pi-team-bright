# Graph replay after Task transitions result

Date: 2026-08-13
Task: `ptb-graph-native-next-gs9`
Implementation: `41c480924b2aefdaf8ded58a8330eee2d89e95c8`
Architecture impact: none outside the accepted graph-retirement internal contract

## Result

Exact graph-command replay no longer conflicts after a retained Task advances.
The durable retirement adapter now compares two distinct meanings:

- stable graph-operation identity uses graph version, graph revision sequence,
  and operation ID;
- monotonic currentness uses graph version, graph revision sequence, authority
  sequence, and the complete exact Task ID+version set.

An exact older graph operation validates its immutable first-write receipt, but
cannot replace a later currentness fence. First-write retired coordinates remain
immutable history. A changed graph version or graph sequence under one operation
ID still refuses.

## Deterministic verification

The exact implementation tree passed `npm run typecheck`. Eight focused files
passed 81 tests. The 14-case replacement suite includes apply X, claim, exact X
replay, goal result, second exact X replay, removal history, changed operation
identity, interrupted retirement repair, retained-version state matrix, staged
acknowledgement, recovery, owner-transition, `/1` repair, and Coordination
compatibility.

Typecheck used a temporary untracked link for the already installed declared
`@dagrejs/dagre@3.1.1` because this worktree's `node_modules` is stale. The link
was removed after the check.

## Exact-source real Worker canary

The isolated coordinator used the required proxy, `packages: []`, repaired
non-secret Worker defaults, and the exact extension at the implementation
commit. It verified `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` names present,
branch `feature/dag-native-rc13`, exact HEAD, isolated Pi directory,
`PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-terra`, medium reasoning, and a
visible `task_graph_apply` tool.

Team `graph-replay-transition-pass-20260813` created stable Worker `builder`.
Graph operation `X` applied one retained Task `keep` at graph
`g_ebe82b66cdda978f`. The initial ready Task was
`v_637ba9b8c1591327`.

Worker-authored operation `claim-keep-637ba9b8` claimed the Task and produced
in-progress version `v_91a504c13620ccbb`. The byte-identical replay of X then
returned `replayed: true` with no warning and retained that exact in-progress
version.

Worker-authored operation `achieve-keep-replay-passed` used exact claim evidence
and the leader's replay-success trigger. It produced goal-achieved version
`v_3f8472191b2f5ae7`. A second byte-identical replay of X returned
`replayed: true` with no warning and retained that exact terminal version.

`team_sync` returned coherent `caught_up` at head 6. Exact `worker_stop` returned
`worker_stopped` for builder. Team shutdown returned
`unfinished_task_ids: []`.

## Constraints

No fallback Session, credential edit, credential content read, Team storage
edit, push, tag, publication, or registry mutation occurred. The isolated
native coordinator and Worker logs remain outside tracked source as raw
evidence.
