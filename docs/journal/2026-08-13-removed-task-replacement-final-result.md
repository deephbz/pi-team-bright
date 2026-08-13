# Removed-Task replacement final result

Date: 2026-08-13
Task: `ptb-graph-native-next-pxb`
Final repair source: `97499015a746bfd19b948749d7bf166c2e158eed`

## Result

Complete graph replacement is coherent across Task authority, delivery,
Coordination, replay, Worker action, and the direct Herdr graph projection.
The final semantic canary passed after one real replay defect was found and
repaired. The direct pane command also passed after the stale worktree
installation received its already-declared Dagre dependency for the canary.

## Implementation and deterministic checks

The primary repair is `6647c9bc14178d354c1e52528ed91b72079da3ee`.
It adds a monotonic graph-revision retirement fence, retires derived delivery
obligations without deleting history, filters Worker presentation and liveness,
and makes Coordination treat graph IDs as a complete current set.

The first final canary exposed a replay mismatch: the first retirement recorded
`removed`, while exact replay recomputed an empty removed set from the already
current graph. Commit `97499015a746bfd19b948749d7bf166c2e158eed` makes
idempotency use stable revision coordinates while retaining the first removed-ID
history. Typecheck and all six focused replacement-coherence tests passed.
Earlier verification also passed the seven-test adversarial set and the 32-test
focused compatibility set.

## Final semantic canary

The exact-source coordinator used `_codex_with_proxy`, Terra-medium, the repaired
Worker default `openai-codex/gpt-5.6-terra`, `packages: []`, and the integrated
extension. Required proxy variables were present.

Team `graph-replacement-pass-20260813` created stable Worker `builder`. The
Membership captured `openai-codex/gpt-5.6-terra`.

Bootstrap operation `graph-replacement-pass-bootstrap-20260813` committed graph
`g_a1ec6633884b9aec`. Task versions advanced:

- ready `v_6c63c97662e270e1`;
- claimed `v_7bc6adfb2d355f51`;
- goal achieved `v_e3d45d23bd5caf11`.

Worker-authored claim and result updates reached `team_sync`. Result evidence was
exactly `replacement pass worker launch proof`.

Initial replacement operation `graph-replacement-pass-initial-20260813`
committed graph `g_58e510dfec53a4ab`, with `removed` ready and `keep` waiting.
Replacement operation `graph-replacement-pass-replace-20260813` immediately
committed only `keep` at `g_13a556b304dabf31`. Exact replay of identical input
returned `replayed: true` with no retirement or delivery warning.

`team_sync` crossed replacement and Worker events without
`task_authority_unavailable`. Current `keep` advanced:

- ready `v_a465c0a4719bf3a8`;
- claimed `v_d5682e61030b288e`;
- goal achieved `v_366dfdd723cb8072`.

Worker evidence recorded the exact removed-read outcome `task_not_found`.
Leader read found current `keep` and returned `task_not_found` for `removed`.
Thus stale removed delivery did not become actionable, while current work did.

Cleanup stopped `builder` only after terminal `keep`. Team shutdown returned no
unfinished Task IDs.

## Direct Herdr graph projection

A separate exact-source, bound pane canary used Team
`graph-pane-pass-20260813`. Its graph contained only current Task `keep`, at
`g_ea47082da7bdee99`. The extension command `/pi-team-graph 25` was dispatched
through `herdr agent prompt`, which invokes Pi extension commands correctly.

The first open exposed a stale local installation: `@dagrejs/dagre` is declared
at version `3.1.1` in package and lock files but absent from this worktree's
`node_modules`. A temporary untracked symlink to the already installed
same-dependency tree restored the declared runtime dependency. No source or
registry changed.

The second open created exact owned pane `w4:p1CZ` in the same Herdr tab. It
reported `Task graph ready · graph-pane-pass-20260813 · 1 tasks`, so the refreshed
projection contained the sole current graph Task and omitted removed work. The
same Pi command closed exact pane `w4:p1CZ`; a subsequent exact pane query
returned `pane_not_found`. The temporary dependency symlink was removed.

The pane-proof Worker completed `keep` to `goal_achieved` at
`v_49e503fda6e869d8`. Cleanup stopped the Worker and shutdown returned no
unfinished Task IDs. An attempted cleanup cancellation correctly refused because
terminal goal achievement cannot be cancelled; it changed no state.

## Boundaries

No fallback Session, credential inspection, durable storage edit, push, tag,
publication, or registry mutation occurred. The pane canary used normal Team and
Pi command surfaces. The temporary dependency link was untracked, matched the
package-declared dependency, and was removed after proof.
