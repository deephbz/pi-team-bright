# Graph-native Team continuation

Updated: 2026-08-13
Stage: iterative integration and real-Team hardening
Branch/worktree: `feature/dag-native-rc13` in the integrated DAG-native checkout.
Team: `ptb-graph-native-next`

## Owner outcome

Continue autonomously until the result is real-world usable and strictly more capable than the prior DAG branch. Do not stop at design or deterministic smoke tests. Iterate implementation, real Pi Team E2E, diagnosis, repair, independent verification, scale testing, and another E2E until all discussed criteria pass without a known correctness blocker.

The target is ordinary graph engineering. A leader authors and can revise a mission graph. Internal control flow is deterministic and does not require leader `team_sync` or `task_update` handoff turns. Success follows forward edges. Explicit bounded failure edges can loop to repair work. Task meaning distinguishes `dependency_waiting`, `ready`, `in_progress`, `blocked`, `goal_failed`, `goal_achieved`, and `cancelled`. Immutable Attempts preserve execution and criterion evidence. Success-only joins bind exact accepted Attempt lineage. `default` and `capable` model aliases resolve per Attempt. A breaking model-facing contract is allowed, but the leader surface stays at nine tools.

The human Task graph pane may couple directly to Herdr and should mimic `herdr-file-viewer` sidebar behavior. It remains a read-only projection of canonical graph authority and adds no model tool. It must remain useful for 20–500 Tasks and many disconnected islands.

## Integrated source and verified capability

Initial graph-control integration: `afbaa35b23e482d30d842c78bab316193b0f6c67`.
Large/disconnected pane hardening: `404025f0da9b3f8de3fcc6c8ec7940d00353def1`.
Clean integrated tip before later E2E fixes: `84c9c89bec5bc40d94e3975b1347778d29a3c13b`.
Pane-run transport repair: `2612fc999eb63c2ac4e1a0bcdb0c425e6051979e`.
First real E2E result artifact commit: `40dd197b4200a9e17734f83f20188ec301c229b3`.

The real graph Team E2E proved:

- exact isolated source and Terra-medium real Workers;
- derived waiting/ready and Worker-authored launch evidence;
- a criterion failure followed one bounded repair edge;
- repaired Attempts alone released success successors;
- success-only join lineage used exact accepted Attempt IDs;
- `default` resolved to Terra-medium and `capable` to Terra-high;
- graph revision retained valid accepted Attempts;
- Worker stop/recovery produced a later Worker-authored result;
- live Herdr panes reached ready at 5, 20, and 40 Tasks;
- 20/100/500 layout p95 was about 2.7/15.2/63.2 ms;
- exact Workers stopped and Team shutdown completed.

Pane hardening uses per-island Dagre layout plus deterministic shelf packing. This fixed a real Dagre crash on disconnected failure-loop graphs. Exact-origin/no-focus Herdr canaries passed at 20, 100, and 500 Tasks. The pane has bounded recent/state filters, visible omission and freshness coordinates, island navigation, distinct states/edge types, and graph-authority snapshot refresh. A 500-Task graph remains tall and needs island navigation; this is a recorded residual usability limit, not a correctness failure.

## Current correctness repair

The first real E2E exposed a release-blocking graph-replacement defect. Complete graph replacement removed Tasks from graph authority but left stale Coordination and delivery references. Later `team_sync` tried to hydrate removed IDs and returned unavailable. Workers could also receive stale removed-Task presentations and then get `task_not_found` on claim.

The selected repair is an idempotent graph-revision retirement boundary after graph authority commit. It must fence or retire removed IDs across pending delivery, acknowledgements, enqueue recovery, owner-transition obligations, Worker presentation, and Coordination projection while preserving Task/Attempt/event history. Exact operation replay must repair an interrupted retirement. Coordination must distinguish retired historical references from genuinely missing current evidence and replace its complete cached projection rather than only additively merge.

Implementation commit: `6647c9bc14178d354c1e52528ed91b72079da3ee`.
Blocked-canary evidence commits: `4c1ba246831938b723c3f43e3ae3832a0911dd37` and retry `4bec21778cdbb26b8349f9395e35915604299d1b`.
Typecheck, seven new adversarial tests, and 32 focused compatibility tests passed.

Both initial real repair canaries stopped before replacement because isolated settings omitted the Worker default provider/model. Workers then fell back to an unrelated Anthropic credential with an invalid refresh token. This was not an OpenAI credential failure.

Authentication diagnosis Task `ptb-graph-native-next-2co` closed. Durable evidence commit: `8545adc28b4134b45f13b6cdbf325a14ca32cfb9`. The supported fix is explicit isolated non-secret settings:

- default provider `openai-codex`;
- default model `gpt-5.6-terra`;
- default thinking `medium`;
- `pi_team_bright.worker.default_model = openai-codex/gpt-5.6-terra`;
- normal auth/model-catalog symlinks, without reading or editing credentials.

A fresh exact-source Team then proved Worker-authored claim and `goal_achieved` events. No human login or credential mutation is needed.

## Replacement repair accepted evidence

The final semantic canary passed on `97499015a746bfd19b948749d7bf166c2e158eed`.
It proved Worker-authored launch, immediate removal of a ready delivered Task,
coherent `team_sync`, removed `task_read` refusal, current `keep` action, exact
replacement replay without warnings, Terra Membership capture, exact stop, and
clean shutdown. Durable result commit: `6ce9ddf13fddb3a19856f125920e902701c8167c`.

A direct pane canary then opened exact same-tab pane `w4:p1CZ` and reported
`Task graph ready · graph-pane-pass-20260813 · 1 tasks` for a graph containing
only current `keep`. The same Pi extension command closed that exact pane, and
an exact read then returned `pane_not_found`. This checkout's stale
`node_modules` lacked declared dependency `@dagrejs/dagre@3.1.1`; a temporary
untracked link to the already installed declared dependency enabled the runtime
proof and was removed afterward. No source or registry changed.

After `pxb` closes, the existing mechanical chain is:

- `ptb-graph-native-next-c0q`: independent adversarial verification of removal repair;
- `ptb-graph-native-next-5eg`: full repaired real graph-Team acceptance E2E;
- prior independent acceptance Task `ptb-graph-native-next-wh8` remains blocked until replacement coherence passes.

Keep using `team_sync({view:"updates"})` as the normal work loop. Recover a failed stable Worker with exact same `ensure_worker` name and scope. Do not inspect panes for routine progress. Use Alerts only for exceptional attention or clarification.

Do not push, tag, publish, or change registry state. Keep public identity and privacy gates. Do not treat deterministic tests or a trace as final proof; require the real replacement canary, independent verification, and final full E2E.
