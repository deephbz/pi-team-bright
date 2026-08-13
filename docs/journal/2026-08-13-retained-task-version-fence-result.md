# Retained-Task version-fence result

Date: 2026-08-13
Task: `ptb-graph-native-next-mh6`
Implementation: `5691c010c04e09e2bfa152080c93a3b179e84f66`
Architecture impact: none outside the accepted internal graph Task-authority and delivery boundaries

## Result

Complete graph and Task-transition fencing now use exact `(Task ID,
TaskVersionRef)` coordinates. The durable `/2` fence also records graph revision
and monotonic graph-authority sequences. Apply and every Task transition advance
the fence after authority commit. Derived delivery, recovery, owner-transition,
tombstone, staging, successful-turn acknowledgement, Worker presentation, and
complete Coordination projection cannot treat a superseded retained-Task
version as current. Immutable records remain historical evidence. Exact replay
repairs interrupted fencing without republishing mutations.

An ID-only `/1` fence cannot establish exact versions. Only replay of its exact
current graph operation can replace it with `/2`; a later graph revision
refuses until that repair occurs.

## Deterministic verification

The exact committed tree passed:

- `npm run typecheck`;
- eight focused files and 79 tests;
- the 12-case replacement suite, including ready, in-progress, achieved,
  failed-loop, join, pending delivery, staged delivery, tool-post-state
  suppression, recovery, owner transition, replay, and `/1` repair states.

The worktree had a stale `node_modules` without declared
`@dagrejs/dagre@3.1.1`. Typecheck used a temporary untracked link to the already
installed declared dependency in the pane branch. The link was removed after
the check.

## Exact-source real Teams

The coordinator used the required proxy, Terra-medium, `packages: []`, repaired
non-secret Worker model defaults, and the exact extension at the implementation
commit. It proved `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` names present,
branch `feature/dag-native-rc13`, exact HEAD, and visible `task_graph_apply`.
Workers captured `openai-codex/gpt-5.6-terra`.

### Functional retained-version canary

Team `graph-retained-version-pass-20260813` proved a Worker-authored bootstrap
claim and result, then retained Task ID `keep` across a definition change:

- bootstrap graph `g_9b1adcde6a7e690e`, ready
  `v_a6dc7a7073cda84f`, claimed `v_48af26c9428cd466`, achieved
  `v_fabc5da98794a119`;
- v1 operation `retained-version-v1-20260813`, graph
  `g_ef5e4935f5c2dd46`, Task `v_8cfaa27801cef67e`;
- v2 operation `retained-version-v2-20260813`, graph
  `g_987eff9456c911b9`, ready `v_60a0243d1aa9cb53`;
- exact v2 replay returned `replayed: true` with no retirement warning;
- stale-v1 claim refused `version_conflict` without a state change;
- v2 claimed at `v_d3bc1af94c15a9a3` and achieved at
  `v_ba84567561b8d6fe` with Worker evidence;
- `team_sync` projected only current v2 Worker action and then returned
  `caught_up` at head 9;
- exact Worker stop and Team shutdown returned `unfinished_task_ids: []`.

This first canary did not prove presentation or acknowledgement suppression.
The native Worker log showed v1 delivery and acknowledgement before v2. That is
valid history, but it corrected the coordinator's initial overclaim.

### Staged-delivery acknowledgement race

Team `graph-retained-version-race-20260813` created a real busy Worker turn. The
Worker claimed v0, recorded `race hold started`, and ran one bounded 20-second
Node timer. While that turn was active, the leader applied v1 and immediately
replaced it with v2:

- v0 operation `retained-race-v0-20260813`, graph
  `g_c999485856f6bf20`, ready `v_718ddc7e89fb39e6`, claimed/context version
  `v_4379458cdd04696e`;
- v1 operation `retained-race-v1-20260813`, graph
  `g_cbcdff6d9bd83755`, ready `v_fa8fa95e3d3dd9c9`;
- v2 operation `retained-race-v2-20260813`, graph
  `g_bbefed013dd46228`, ready `v_06691579d0044d3b`;
- exact v2 replay returned `replayed: true` with no warning;
- stale v0 and stale v1 updates both refused `version_conflict`;
- v2 claimed at `v_254958dce425e640` and achieved at
  `v_b03ba9160cefda78` with Worker evidence;
- `team_sync` projected only current v2 action and returned `caught_up` at head
  8;
- exact Worker stop and Team shutdown returned `unfinished_task_ids: []`.

The normal Team tools do not expose delivery or successful-turn acknowledgement
receipts. The retained native Worker session is therefore the external signal
for that boundary. It contains one v1 custom delivery record but no v1
`pi-teams.task-change-successful-turn-ack`. It contains the v2 custom delivery
and one v2 successful-turn acknowledgement. Thus v1 presentation remains
historical evidence, but the post-replacement successful-turn boundary fenced
its acknowledgement and only v2 acted.

## Constraints

No fallback Session, credential content read, credential mutation, Team storage
edit, push, tag, publication, registry mutation, or broad aggregate ran. The
isolated canary root and native Session logs remain outside tracked source as
raw evidence.
