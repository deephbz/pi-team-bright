# Leader-stable layout and rc.3 publication handoff

Date: 2026-08-03

## Owner request

Finish the pane-layout repair, empirically verify real teammate spawn and shutdown with the Herdr CLI, then publish a new npm version. The intended next version is `0.17.0-rc.3` unless repository policy produces a different required prerelease.

## Completed earlier in this working tree

The uncommitted tree already contains the prior accepted work:

- removed preview-only production registration concepts and leader/standalone prompt injection;
- Worker `alert_send` has no recipient field and derives `team-lead`;
- Worker launch retains exact `-e` loading but no longer uses `-ne`, so unrelated extensions remain discoverable;
- Worker active-tool projection removes only Pi Team Bright leader tools, including after envless recovery and Worker settings;
- candidate `current_context` now uses one shared standard TypeBox `maxLength: 2000` schema and runtime `Check` predicate;
- every owned candidate metadata write refuses invalid context before mutation;
- external/legacy invalid metadata returns typed `candidate_metadata_invalid` gaps without throwing or advancing Team observation;
- Worker receipts read validated canonical candidate metadata and never copy unbounded native notes into `current_context`.

The final pre-layout aggregate passed: `npm run test:full` with 67 files and 518 tests, `qa:agent-surface`, `verify:package`, typecheck, and `git diff --check`.

Exact `-e` decision: retain it. A Worker is a new Pi process and does not inherit the leader extension registry. Normal discovery cannot guarantee the current source for checkout-based explicit loads, different Worker cwd, or untrusted project discovery. Supported Pi 0.80.10 and 0.82.1 deduplicate the same canonical explicit/discovered path. A distinct stale installation remains a bounded risk.

## Layout contract and current implementation

Team: `ptb-layout-invariant`.

Last synchronized cursor before this handoff: `37`.

Implementation Task: `ptb-layout-invariant-7ey`, currently closed after its second implementation round.

Independent layout verification Task: `ptb-layout-invariant-g42`, currently blocked by real evidence and linked to the implementation Task during repair. It must be resumed only after the remaining setup/lifecycle issue is resolved.

Release verification Task: `ptb-layout-invariant-nwz`, blocked by both implementation and independent layout verification.

Product observer Task: `ptb-layout-invariant-v0p`, closed.

Systems observer Task: `ptb-layout-invariant-e3u`, closed.

Current implementation adds `TeamPanePlacement` and `src/utils/team-pane-placement.ts`. The Worker launch bridge derives the exact durable leader pane and current active Worker panes. It does not use ambient focus.

Herdr now:

- requires exact Team placement;
- validates pane identity;
- validates that a later Worker target remains in the leader tab/workspace and to the right of the leader;
- splits the first Worker to the right;
- splits later Workers downward inside the Worker region;
- refuses stale or moved targets;
- closes only the exact Worker pane.

Tmux now:

- requires exact Team placement;
- validates window and pane geometry;
- creates the first right-side Worker region with `split-window -h -l 40%`;
- splits later exact Worker panes vertically;
- no longer invokes whole-window `select-layout main-vertical`;
- refuses stale or moved targets instead of using the current pane.

README and `docs/current/README.md` state that only Herdr and tmux currently guarantee this exact-target/ratio invariant. Other adapters retain existing behavior and do not claim it. The adapter contract is an architecture-contract change, but no depicted component, dependency, or topology changed, so Structurizr DSL is unchanged.

## Independent real Herdr evidence and open blocker

Evidence artifact:

`docs/journal/artifacts/2026-08-03-herdr-leader-placement-verification.json`

The first real isolated working-tree Team run proved that Herdr `--ratio` is the existing-pane share. The original `--ratio 0.4` made the leader 33/82 wide, or 40.24%. Implementation corrected the first Herdr split to `--ratio 0.6`; focused command coverage was updated.

The same real run could not complete Worker lifecycle proof. Both Worker carriers failed with:

`agent_name_not_found: named agent <worker> no longer owns the target terminal`

The implementation worker attributed this to the verifier using Pi 0.83.0, outside package peer support (`^0.80.10 || ^0.82.0`). Herdr owns the canonical `pi` executable used by `herdr agent start`; the current installed global Pi is 0.83.0. This attribution is not yet independently proven. Do not publish until a successful real teammate lifecycle run exists.

Next action after compaction:

1. Resume with `team_sync` on Team `ptb-layout-invariant` from cursor `37`.
2. Read current Tasks before mutation because versions may have advanced.
3. Determine a safe supported-Pi Herdr verification method. Do not change or stop unrelated panes. Use a dedicated disposable Herdr tab/workspace, explicit pane IDs, `--no-focus`, and the working-tree extension.
4. If Herdr can be configured to use Pi 0.82.1 only for the disposable run, do so without changing unrelated live sessions. Otherwise diagnose `agent_name_not_found` as a production adapter issue rather than accepting the Pi-version hypothesis.
5. Run a real Team lifecycle: one leader, at least two Workers, `worker_stop`, and `team_shutdown`. Record `herdr pane layout` after each action. Prove the leader remains left and at least 60% wide, later joins/stops do not alter its topology while Workers remain, and cleanup touches only disposable panes.
6. Update the evidence artifact or add a new passed artifact. Resume and close `g42` only with independent executable evidence.
7. Request final product and systems observer reviews after real evidence settles.

## Publication state and required order

Current branch is `main`; HEAD before these uncommitted changes is `7ccad1d`. Origin is `https://github.com/deephbz/pi-team-bright.git`. GitHub CLI authentication is active for `deephbz`. npm authentication is active as `silverbreenz`.

Registry observation before handoff:

- npm `next` points to `0.17.0-rc.2`;
- npm `latest` points to `0.17.0-rc.1`;
- local package metadata is still `0.17.0-rc.2`.

Publishing policy is `.github/workflows/publish.yml`. It uses GitHub Actions OIDC provenance, Node 24, `npm ci`, Beads materialization, full tests, test-lane verification, package verification, and `npm publish --access public --provenance --tag next` when `dry_run=false`.

After layout verification passes:

1. Create a separate release-preparation implementation Task and Worker. Bump package and lockfile to `0.17.0-rc.3` without creating a tag yet. Also update `pi.image` and `MODEL_TOOL_IMPLEMENTATION_VERSION` from rc.2 to rc.3. Search all current executable/release metadata for stale rc.2 values and distinguish historical journals from current contract files.
2. Regenerate derived docs/artifacts required by current scripts. Do not hand-edit generated authority.
3. Have `release-verifier` independently run full tests, `test:lanes`, QA, package verification, dry-run pack inspection, clean install, privacy/secret checks, and exact-tree review.
4. Commit the complete source bundle. Confirm a clean tree. Push `main`.
5. Dispatch `.github/workflows/publish.yml` on the exact pushed commit with `dry_run=false`, `tag=next`, and a unique nonce.
6. Wait for workflow completion. Verify registry version, `next` dist-tag, integrity, shasum/tarball, provenance, and workflow commit SHA. Create durable release evidence. Add a Git tag/release only if current repository policy requires it; do not invent a tag before checking the current rc.2 delivery pattern.
7. Reconcile all Tasks and Workers, then shut down the Team.

Do not publish from the dirty local tree or with the unresolved real Herdr lifecycle blocker.
