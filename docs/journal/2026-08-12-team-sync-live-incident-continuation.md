# team_sync live incident continuation

Date: 2026-08-12
Stage: hardening; product acceptance passed, release gates remain open

## Owner intent

Treat the repeated leader `team_sync` freeze as a production-critical incident.
Fix its root causes before aggregate or release. Keep the leader on
`openai-codex/gpt-5.6-sol` high. Terra medium is Worker-only.

## Observed evidence

The Sol takeover leader Session was
`019ff539-370e-716b-aa8f-f921c4df0d44`, process `71463`, Team
`rc14-sol-takeover`. External monitoring recorded `team_sync` durations of
88.384 and 137.247 seconds. Process samples are:

- `/tmp/ptb-team-sync-sample-20260812T091450Z.txt`
- `/tmp/ptb-team-sync-watchdog-sample-1786526275689.txt`

The first sample spent 4119 of 4122 main-thread samples in the FSEvents
callback. The second spent 2305 of 2306 there. The second incident also had two
concurrent live `bd ... list` children from the same leader, started 29 seconds
apart, plus a zombie. Thus Beads was duplicated downstream work, not the first
cause.

The external monitor ran in Herdr pane `w4:p19R`. Its append-only evidence is
`/tmp/ptb-team-sync-watchdog-20260812.jsonl`. It alerts at 5 seconds, requests a
process sample at 15 seconds, and escalates at 60 seconds. It is diagnostic
infrastructure, not the product repair.

The prior Terra leader became stuck too. Owner authorized takeover. Exact
Worker PIDs and panes were proved absent. A locked atomic stale-Team rescue
deactivated five old Memberships. Its private receipt is
`/tmp/rc14-direct-leader-rescue-20260812T090610Z.json`. Historical authority
records remain preserved.

## Root-cause assessment and current repairs

Three defects combined:

1. Runtime readers joined the producer lock although writers already publish a
   complete atomic replacement. Current source makes runtime reads lock-free and
   keeps writer locking plus atomic rename.
2. macOS can emit directory watch events without a filename. Treating these as
   positive hints created a self-sustaining FSEvents scan loop. Current source
   ignores missing filenames and wakes only on exact runtime `*.json` or exact
   `team-events.jsonl`. The five-second authority cadence is the safe fallback.
3. A waiter could time out or cancel while `checkAuthority` remained in flight.
   Its final or later `team_sync` could start another complete Task-authority
   read, producing overlapping Beads processes. Current source adds one in-flight
   complete Task-projection Promise per Team inside
   `CoordinationObservationService`; callers join it, and it clears only after
   settlement.

The recovery repair also exists in the shared tree. It adds pure runtime
recovery preflight, removes the leader's post-spawn runtime admission, binds
candidate startup to the expected Membership ID, serializes exact Membership
revalidation/spawn/target persistence, and keeps exact-target compensation.
The replacement child alone claims and publishes runtime startup.

Focused evidence already passed:

- liveness and single-flight: four files, 52 tests;
- recovery: four files, 54 tests;
- TypeScript passed;
- Git diff check passed after one trailing-space correction.

All `rc14-sol-takeover` Tasks were observed closed. All its Worker panes were
absent. Team config later had zero active Memberships. The old Sol leader and
external watchdog processes were stopped after durable preservation. Do not
reuse that old leader process.

## Current tree

The worktree has uncommitted production, test, release-doc, and evidence changes.
Do not revert them. Key changed production paths include:

- `src/utils/runtime.ts`
- `src/utils/sync-liveness.ts`
- `src/coordination/observation-service.ts`
- `src/team-authority/worker-launch-bridge.ts`
- `src/team-authority/team-session-lifecycle-service.ts`
- `extensions/pi-team-session-adapter.ts`

Key new/updated tests include runtime, liveness E2E, observation-service
single-flight, Session lifecycle, launch compensation, and ergonomic recovery.
The incident artifact is
`docs/journal/artifacts/2026-08-12-team-sync-macos-feedback-storm.json`.
Release planning and checklist drafts exist. The candidate version is still
rc.13; rc.14 has not been committed, tagged, pushed, packed, or published.

## Documentation curation status

The curation Worker recorded `openai-codex/gpt-5.6-terra` at medium reasoning.
It recorded proxy-name presence for `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
and `NO_PROXY`; values were not retained. This confirms only this Worker's
preflight. It does not replace the historical Sol-leader evidence above or
prove the required E2E, aggregate, repair acceptance, or release. The dated
[curation record](2026-08-12-rc.14-artifact-curation.md) preserves the exact
scope and limits.

## Continuation correction

The required isolated product acceptance now exists. Team `rc14-isolated-e2e`
used a Sol-high leader and eight Terra-medium Workers through the exact
working-tree extension. It closed nine Tasks, proved one logical Worker
replacement with a second Worker-authored result, stopped all current Workers,
and shut down with no unfinished Tasks. Across 27 non-overlapping `team_sync`
calls, product duration was 16 to 5,308 ms. The monitor found at most one live
Beads list child and no observed FSEvents storm. The durable
[receipt](2026-08-12-rc14-isolated-exact-source-e2e-receipt.md) supersedes the
open E2E gates above. `fs_usage` was unavailable because it required root.

The remaining order is to commit the exact reviewed candidate, run the reserved
aggregate once, complete all package and release gates, then publish rc.14
through main CI, hosted dry-run, annotated tag, OIDC npm `next`, provenance,
GitHub prerelease, and the final immutable receipt. The optional progress
projection remains deferred because correctness no longer depends on it.

Do not claim final delivery before registry, provenance, GitHub, final main,
clean worktree, and Team shutdown evidence exist.
