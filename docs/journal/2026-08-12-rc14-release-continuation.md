# rc.14 release continuation

Date: 2026-08-12
Stage: hardening to sharing
Base and origin/main: `53367e412ad0217bfcf4845d92a07bb9ebec6de2`
Candidate version in package and lock: `0.17.0-rc.14`
Publication state: completed by exact source `8bb517bd32d8687e97b96a531db15833fd64420a`; see the rc.14 release receipt

## Owner intent

Finish the liveness and Worker-recovery fixes end to end, then release rc.14.
Do not ask for authorization in the middle. The leader must use
`openai-codex/gpt-5.6-sol` at high reasoning. Workers use
`openai-codex/gpt-5.6-terra` at medium reasoning.

## Implemented repairs

- Runtime status reads no longer join writer locks. Writers still use locking
  and atomic replacement.
- macOS watcher events require exact string runtime `*.json` or
  `team-events.jsonl` names. Null and unrelated filenames are ignored.
- One liveness scan runs at a time, with one coalesced authority-priority scan.
- `CoordinationObservationService` keeps one complete Task-projection read per
  Team. Timed-out or cancelled waiters, final reads, and later reads join it.
  Promise-identity clearing permits a fresh read after settlement.
- Worker recovery holds the exact Membership lease through revalidation,
  runtime preflight, spawn, and terminal-target persistence.
- The replacement child alone claims runtime startup. It receives the expected
  Membership ID, and stale children refuse before admission.
- Exact-target compensation and concurrent-reuse behavior remain intact.

Independent Terra-medium review found no contract, persistence, public-schema,
observation-meaning, or recovery defect. Focused liveness, recovery, timeout,
cancellation, compensation, Session, ergonomic, typecheck, and diff checks
passed. The reserved aggregate has not run.

## Real isolated macOS E2E

The first exact-source attempt failed because explicit `-e` ran beside an
ambient globally discovered Pi Team Bright package. Herdr then reported
`agent_name_not_found` after the child lost named-agent ownership. This was the
known duplicate-install risk, not a proven Herdr adapter defect. It shut down
cleanly. Historical receipt:
`docs/journal/2026-08-12-rc14-exact-source-e2e-failed-attempt.md`.

The replacement used an isolated `PI_CODING_AGENT_DIR` with no ambient package,
explicit worktree `extensions/index.ts`, a Sol-high leader, and Terra-medium
Workers through `_codex_with_proxy`. Team `rc14-isolated-e2e` created eight
Workers and nine Tasks. All Tasks closed with Worker-authored evidence. Worker
`e2e-1` stopped normally, recovered once under the same logical identity, and
closed a second Task. All eight current Workers stopped exactly. A final sync
reconciled eight stops. `team_shutdown` returned zero unfinished Tasks.

External payload-free evidence:

- Session: `/tmp/ptb-rc14-isolated-pi/sessions/2026-08-12T10-01-57-902Z_019ff56b-e98e-7279-b8b9-34be366c23fb.jsonl`
- Watchdog: `/tmp/ptb-rc14-isolated-watchdog.jsonl`, SHA-256
  `75871f02321bb6e189132d75e83dbcbc54945b254ab16f85888ffadb71383786`
- Timings: `/tmp/rc14-isolated-sync-durations.jsonl`, SHA-256
  `0cd205363e6ac2d2ab809a5df62bf99d6cf16e7508a61b63a08cd61937ca99e1`
- Exact extension SHA-256:
  `7452bfee99b3ca4169b9c148671c96e9cff6f3c9055b3298233c4e00a201298d`
- The external monitor matched 27 `team_sync` starts and ends. Product-call
  duration was 16 to 5,308 ms. No call exceeded 15 seconds or overlapped.
- Maximum live descendant Beads list count was one.
- Seventy-four one-second samples each contained three `FSEvent` string
  occurrences, not the thousands observed during the incident.
- `fs_usage` could not run without root, so it is not evidence.
- Manual shell markers exceeded 15 seconds for calls 12 and 20 because they
  include Sol reasoning and shell turns. Keep them as harness evidence, not
  product-call latency.
- One Task creation returned unknown after a Beads timeout and succeeded through
  exact operation retry. Treat it as existing contention behavior.

The E2E leader is writing the durable successful receipt and requested product-
user interview. Expected paths:
`docs/journal/2026-08-12-rc14-isolated-exact-source-e2e-receipt.md` and
`docs/journal/2026-08-12-rc14-e2e-leader-interview.md`. Confirm their names after
compaction before relying on them.

## Current tree and release preparation

Do not revert shared changes. Production paths include runtime, sync liveness,
Coordination observation single-flight, Worker launch, Team Session admission,
and Pi Session Membership-ID wiring. Tests cover all changed boundaries.
Maintained semantic-hardening context/result/journal and current evergreen have
uncommitted curation updates. Incident, plan, failed-attempt, notes, checklist,
and evidence artifacts are untracked.

`npm version 0.17.0-rc.14 --no-git-tag-version` already updated package and lock.
README install, package image, the image compatibility fixture, and the model-
tool parity release header were updated to rc.14. The rc.14 release-notes draft
now states the selected repairs and isolated E2E evidence. `git diff --check`
and version consistency passed after these edits. Global Pi settings retain
Worker `default_model=openai-codex/gpt-5.6-terra`; leader default reasoning was
restored to high.

## Completion correction

The open steps below are historical handoff state. Exact source
`8bb517bd32d8687e97b96a531db15833fd64420a` passed the reserved aggregate and
all release gates. Annotated tag `v0.17.0-rc.14` published through hosted OIDC
run `31592109336`. npm `next`, registry equality, SLSA provenance, and the
GitHub prerelease passed. The durable
[release receipt](2026-08-12-v0.17.0-rc.14-release-receipt.md) supersedes this
continuation for current status.

## Historical required next order

1. Let the isolated Sol leader finish its successful receipt and interview, then
   stop that Pi process normally. Keep its completed Team shut down.
2. Review the two new artifacts, current Git status, exact diff, and links.
3. Update evergreen, semantic-hardening context/result/journal, rc.14 plan,
   checklist, and notes to reflect the successful E2E without overstating
   `fs_usage` or manual marker timing.
4. Run final JSON, links, version, source/public/persistence, graph, privacy-range,
   and diff preparation checks. Commit one coherent rc.14 candidate with public
   identity `deephbz` and GitHub noreply email.
5. On the exact clean committed candidate, run `npm ci --workspaces=false`, then
   the reserved aggregate exactly once:
   `TERM_PROGRAM=iTerm.app npm run test:full`.
6. Run package/generated verification, lanes, agent/tool-result QA, public and
   persistence comparisons, graph, JSON, links, privacy, detached one-pack
   install, CommonJS and TypeScript observation, owned Beads, and bounded Pi-load
   gates. Record exact receipts.
7. Push main only after every local gate passes. Wait for exact-source Node 22/24
   CI. Run hosted publish dry-run with `tag=next` and a unique nonce.
8. Create and push annotated `v0.17.0-rc.14`. Run hosted OIDC publish with a new
   nonce. Verify npm version, `next`, integrity, downloaded tarball, and SLSA
   provenance. Create the GitHub prerelease.
9. Append the immutable release receipt and push it. Require local HEAD equals
   origin/main and a clean worktree.

Use normal Git hooks. Never bypass privacy checks. Use `npm-auth` only for local
authenticated npm operations; hosted publication uses OIDC. Do not touch the
separate DAG-native line.
