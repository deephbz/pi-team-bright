# Coordination correctness implementation continuation

Date: 2026-08-07
Stage: hardening and release preparation
Architecture impact: none at topology/component level; public coordination contracts changed

## Owner decisions

- Remove only Worker `team_name` from Worker `task_read`, `task_update`, and `alert_send`. Derive Team identity from the exact runtime binding. Preserve Task IDs, operation IDs, versions, capabilities, results, and semantics.
- Require Pi 0.83 or later. A separate audit is checking Pi 0.84 compatibility.
- `team_sync({view:"updates"})` waits only with positive producer evidence, returns normal `caught_up` for proven quiescence, and returns `indeterminate` for incomplete evidence.
- The global `pi_team_bright.team.wait_seconds` setting defaults to 120.
- Automatic sync nudges are enabled by default. Their default delay is 1,200 seconds. A valid explicit `false` disables nudges.
- A nudge is one internal presentation fact with model-facing custom-message, durable machine, and TUI projections. It is neither an Alert nor Task authority.

## Integrated implementation

The reviewed integration commit is `79cea8c893a01b978f38f6e99368537697e9e3cb` on `dev/coordination-integration`.

It includes:

- exact Worker runtime Team/Membership/Session binding with the narrow Worker schemas;
- canonical event Task hydration, exact response cardinality, restart and branch-safe baselines, and page-cursor acknowledgement;
- failed Task-event publication hints with actor, epoch, Task version, and monotonic cursor evidence;
- exact Worker `active | settled | unknown | absent` evidence and pending-actuation checks;
- producer-aware bounded waits, `caught_up`, `indeterminate`, and branch-safe pending-result acknowledgement;
- persisted Team-epoch settings, Pi `>=0.83`, default enabled nudges with 1,200-second delay, exact identity/debt dedupe, reservation/presentation crash recovery, and five-second minimum Task-authority rescan cadence.

Independent implementation review found no code blocker. It passed typecheck, diff check, and 49 focused tests. The review classified Structurizr topology impact as none. Release documentation remained a blocker.

The integration builder reported 57 final focused tests and 107 additional event/Worker/liveness/hint tests passing. Independent event-source verification passed 57 tests. Worker surface verification passed. Liveness verification found a one-second default authority-scan mismatch; source commit `3807980` fixed it. Owner-default source commit `283bd15` set enabled/1,200-second nudge defaults and was replayed in the integration.

## Release state

The intended next version is `0.17.0-rc.9`.

Active release preparation Task `coordination-correctness-dev-ih8` must create the release branch from exact integration commit `79cea8c`, update package/package-lock and install/image references, close `docs/current/README.md` and `docs/release/model-tool-parity-checklist.md`, include the research handoff and this continuation artifact, and create only a release-plan artifact. It must not claim publication.

Active final verification Task `coordination-correctness-dev-gdu` must run the aggregate `test:full` lane once, test-lane closure, and one real isolated two-Session proof. That proof covers quiescent `caught_up`, exact Worker active/settled evidence, Worker Task mutation, short configured nudge delay, durable/model/TUI nudge projections, no Alert/Task mutation, and sync acknowledgement.

After release-source preparation and exact-source verification, release procedure is: clean main, full/package gates without repeating the broad lane, exact tarball and isolated Pi install canary, privacy scans, hosted dry-run, annotated `v0.17.0-rc.9` tag, OIDC publish with npm `next`, registry/provenance proof, GitHub prerelease, and durable publication receipt. Use the approved public Git identity. Do not publish locally with a token.

## Pi 0.84 audit

Task `coordination-correctness-dev-p4m` is active on exact integration commit `79cea8c`. It compares Pi 0.83 and 0.84 metadata, types, and runtime behavior for lifecycle events, idle/pending APIs, message renderer, custom-message delivery, Session branch APIs, tool registration/results, pi-ai, pi-tui, package loading, and Worker launch. It must report proven pass, confirmed break, risk, and untested boundaries without editing production. Treat a confirmed 0.84 break as a release decision input, not an implicit scope expansion.

## Repeated `team_sync` execution error

This is a real scale/timeout defect, not only a transient UI error. In the active 35-Task Team, sanitized direct measurement showed:

- Team-scoped `bd list`: 0.99 seconds;
- one `bd show` for all 35 IDs with `--include-dependents`: 12.00 seconds;
- Pi Team Bright Beads command timeout: 10 seconds.

Sequential 16-ID show batches completed in 5.80, 6.04, and 1.57 seconds. Repeated `team_sync` failures named both the large multi-ID show and, under contention, list/show authority operations. The current README already calls Beads contention unresolved, but this measurement identifies a deterministic large-show timeout in addition to transient contention.

Task `coordination-correctness-dev-4r6` is auditing the exact path, small-Team comparison, contention, batching, and timeout ownership. Release decision remains open. A bounded multi-ID batch limit is the likely small repair; a global timeout increase can hide authority stalls and increase mutation uncertainty. Do not change the release source until the auditor gives a release-blocker verdict and focused regression evidence.

## Active Team and continuation order

Active Team: `coordination-correctness-dev`. It contains many closed Tasks, so whole-Team `team_sync` and multi-Task reads themselves can exceed the Beads timeout. Use individual `task_read` calls when synchronization fails. Do not interpret the failure as lost Task state.

Continue in this order:

1. Read Tasks `coordination-correctness-dev-gdu`, `coordination-correctness-dev-ih8`, `coordination-correctness-dev-p4m`, and `coordination-correctness-dev-4r6` individually.
2. Decide the Beads timeout repair from the audit. If small and focused, implement and independently verify it before rc.9 source finalization. Otherwise record deferral and release risk.
3. Apply any accepted repair to the integration and release branches, then repeat only its focused checks. The final verifier runs the aggregate lane once on the exact final behavior tree.
4. Complete rc.9 release-source documentation and version commit.
5. Create a new small release Team after all current nonterminal Tasks close; the current Team's large historical Task set causes synchronization timeouts.
6. Run exact release gates, publish through OIDC, prove registry bytes and provenance, create the GitHub prerelease, and add the final receipt.

The leader worktree has no production edits. Before fast-forwarding main, preserve and include the untracked research handoff and this continuation artifact so the untracked paths do not block checkout.
