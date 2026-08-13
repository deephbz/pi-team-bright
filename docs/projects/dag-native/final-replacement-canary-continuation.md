# Final removed-Task replacement canary continuation

Updated: 2026-08-13
Task: `ptb-graph-native-next-pxb`
Last known Task version: `v_175e571f9f01ffe2`
Status: in progress

## Durable source

- Repair commit: `6647c9bc14178d354c1e52528ed91b72079da3ee`.
- Current clean checkout before this canary: `8545adc28b4134b45f13b6cdbf325a14ca32cfb9`.
- Focused evidence remains: typecheck, seven new adversarial tests, and 32 focused tests passed.
- Authentication recovery evidence: `docs/journal/2026-08-13-worker-authentication-recovery-result.md`.

## Active canary

The final exact-source coordinator runs in Herdr pane `w4:p1CQ`. It uses the repaired isolated Pi root `/tmp/ptb-auth-recovery.c8BrIu/pi-home`, `_codex_with_proxy`, explicit coordinator model `openai-codex/gpt-5.6-terra:medium`, `packages: []`, and the exact integrated extension.

The coordinator received the full final-canary contract. It created Team `graph-replacement-final-20260813` and created stable Worker `builder`; `ensure_worker` returned a connected carrier. At the last observation, the coordinator was still working immediately after Worker creation. It had not yet reported the bootstrap graph apply, Worker-authored launch events, replacement, replay, sync, pane, or cleanup evidence.

Do not create another Team or fallback Session. Resume by waiting for the current coordinator lifecycle state, then read its exact result. If it stopped early, prompt the same exact coordinator to continue or clean up through normal Team tools.

## Required remaining evidence

1. Bootstrap Worker-authored claim and `goal_achieved` events with evidence `final canary worker launch proof`.
2. Apply a graph where `removed` is ready and `keep` depends on it, so removed delivery is queued.
3. Replace immediately with only `keep`, before `removed` can claim.
4. Exact-replay identical replacement and require `replayed: true` with no retirement warning.
5. `team_sync` must cross historical removed events without `task_authority_unavailable`.
6. Worker `task_read removed` must return `task_not_found`; Worker must then claim and achieve current `keep` with that outcome in evidence.
7. Leader reads must find `keep` and report `removed` missing.
8. Open the supported direct Herdr Task graph pane, prove refreshed graph contains `keep` and omits `removed`, then close only that owned pane.
9. Confirm Membership captured `openai-codex/gpt-5.6-terra`.
10. Stop `builder` only after current work is terminal; shutdown must return no unfinished Task IDs.

Preserve exact operation IDs, graph and Task versions, sync outcomes, Worker evidence, pane evidence, stop receipt, and shutdown receipt. No fallback Session, credential inspection, storage edit, push, tag, or publication.
