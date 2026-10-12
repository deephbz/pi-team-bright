# Scenario verification

Purpose: verify Team observation at the Coordination and native Pi boundaries.
Scope: deterministic tests and isolated real-Pi runs with a scripted loopback
provider. These checks do not measure live-model judgment or remote providers.

## Contract checks

Run the focused suite during a cursor change:

```sh
npx vitest run src/coordination/sync-continuity.test.ts extensions/team-update.test.ts src/model-tool-contract/in-memory-authority-ports.test.ts
```

- [`sync-continuity.test.ts`](../../src/coordination/sync-continuity.test.ts)
  checks branch cursor scope, compaction, tree navigation, fork authorization,
  reservation contention and expiry, snapshot watermarks, and authority
  reconciliation. Stale Task events and retired Worker events must not hide
  an eventless Task change. Worker hydration occurs after the watermark.
- [`team-update.test.ts`](../../extensions/team-update.test.ts) checks idle
  publication, native page framing, owner fences, held-send loss, and failed
  automatic-send suppression. Manual `/ptb sync` remains available.
- [`in-memory-authority-ports.test.ts`](../../src/model-tool-contract/in-memory-authority-ports.test.ts)
  composes the production Coordination service with in-memory authority and
  journal primitives. It exercises the production service only.

Run `npm test` on the final tree. Run the out-of-fast-lane boundary checks
explicitly when changing observation or publication:

```sh
npx vitest run --config vitest.full.config.ts test/coord-liveness-e2e/sync-liveness.test.ts test/formal-adversarial/publication-window.test.ts src/utils/formal-hardening-public-recovery.test.ts
```

[`PublicationObservation`](../../formal/PublicationObservation.tla) and
[`MembershipFence`](../../formal/MembershipFence.tla) retain their bounded
claims. Run `npm run verify:formal` with the pinned jar described in
[`formal/README.md`](../../formal/README.md). `SyncPresentation` is retired
under `formal/retired/`; its provider-acknowledgement model is obsolete and makes no current claim.
Formal checks do not prove Pi hook or queue timing.

## Real-Pi checks

Install dependencies with `npm ci`. Put Node, tmux, and `bd` on PATH.

```sh
npm run e2e:team-sync-scenarios
```

The [runner](../../scripts/team-sync-scenarios/run.mjs) uses the retained
[RPC harness](../../scripts/team-sync-continuity-e2e/harness.mjs), the production
PTB extension, an isolated HOME and settings directory, native Session files,
a private tmux socket, and a loopback provider. It never controls an existing
terminal server or uses remote credentials.

| Scenario | Prediction and boundary |
| --- | --- |
| S1 | A native snapshot stamps its page. The next assistant turn returns `caught_up`. Actual Pi compaction retains the raw cursor, and a new snapshot restores current context. |
| S3 | `/ptb sync` persists `ptb.team-update` with a page line. The exact content reaches the provider. The next model sync succeeds without a synthetic call. |
| S5 | A test context hook removes one persisted result from model input. Its native cursor remains delivered. The next updates call returns `caught_up`; an explicit snapshot restores context. |
| S6 | A historical unstamped result renders collapsed and expanded. Session reload preserves its model-visible bytes. Historical readability does not authorize an old cursor. |

The runner prints one JSON result per scenario. It asserts predictions before
printing success. Set `PI_TEAM_SYNC_TEST_PI_CLI` to test another installed Pi.
Set `PI_TEAM_SYNC_TEST_RETAIN=1` to retain isolated files for diagnosis. Treat
retained Session and provider data as private evidence.

S2/S4 duplicate arbitration now has a direct production-service test. The
former provider-proof-loss scenario is replaced by S5's native-persistence
contract. Old scenario and traversal counts remain historical evidence in
`docs/journal/`; they are not current acceptance criteria.

## Add a scenario

Keep assertions in the runner and process isolation in `harness.mjs`.
`prompt()` stops at a provider request. `step(...calls)` emits a scripted
assistant tool message and stops at the next request. `finish()` waits for
`agent_settled`. Use call IDs to select results. Native `team_sync` content has
a page line followed by JSON; the harness parser handles that framing.

Name the plausible failure and prediction before running a scenario. Preserve
its output outside the repository. A scripted real-Pi result verifies the
observed native path. It does not certify all queues, providers, or terminal
renderers. Architecture impact: none for this verification method.
