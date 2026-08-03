# Worker Alert, current-context limit, and extension-composition handoff

Date: 2026-08-03
Team: `ptb-worker-alert-context-limit`
Continuation cursor last observed: `41`

This is a temporary continuation artifact for the active uncommitted working tree. Task authority remains the executable work contract.

## Operator requests

1. Simplify Worker `alert_send`: Workers can send only to `team-lead`, so the Worker schema must omit recipient fields and execution must derive the leader target. Leader targeting and announcements must remain unchanged.
2. Investigate the unsafe 640-grapheme `current_context` boundary.
3. Preserve normal Pi extension composition for Workers. Disable only Pi Team Bright leader tools, not every other extension.

## Current progress

- Task `ptb-worker-alert-context-limit-ozg` implemented implicit Worker Alert targeting and closed.
- Independent Task `ptb-worker-alert-context-limit-5ge` found a release-blocking regression and is blocked by Task `ptb-worker-alert-context-limit-286`.
  - Actual Workers correctly omit `to`/`target` and forged fields cannot redirect clarification or attention away from `team-lead`.
  - `PI_AGENT_NAME=team-lead` was incorrectly classified as a Worker. This redirected leader Alerts and refused leader announcements.
- Task `ptb-worker-alert-context-limit-286` is in progress on `alert-implementation`. It owns both:
  - fixing explicit `team-lead` role classification while keeping Worker implicit targeting; and
  - removing Worker launch `-ne` so global and trusted-project extension discovery remains active, while retaining exact Pi Team Bright `-e` loading.
- Pi 0.83 resource-loader source confirms identical CLI and discovered extension paths are canonicalized and de-duplicated by `mergePaths`. A different stale Pi Team Bright path remains a bounded duplicate-source risk. The operator explicitly prioritizes normal extension composition over blanket discovery suppression.
- Worker active-tool projection must preserve its captured active baseline, including tools from other extensions. It must remove only Pi Team Bright leader-only tools and add the three Worker tools. Do not add a CLI tool allowlist.

## 640-grapheme investigation result

Task `ptb-worker-alert-context-limit-82f` is closed. The durable result is:

- `docs/journal/2026-08-03-current-context-640-reproduction.md`

Confirmed facts:

- A real Beads 1.1 external write persisted 641 ASCII characters in candidate metadata.
- Candidate parsing accepted the record.
- `task_read` later threw `Invalid semantic result for task_read.`
- `team_sync` snapshot and updates later threw `Invalid semantic result for team_sync.`
- The marked Worker `append_note` path can also copy an unbounded note into candidate `current_context`.
- Worker receipt adaptation can map unbounded native notes into `current_context`.
- TypeBox 1.1.38 measures the 640 limit in Unicode grapheme clusters, not UTF-16 units or code points.

The investigation recommends one grapheme-aware validator at the candidate-metadata boundary. Owned writes must reject 641 before mutation. Existing oversized records must remain unchanged and return typed `candidate_metadata_invalid` gaps from reads and sync, without advancing observation. Native notes need a separate explicit policy and must not be silently truncated.

The operator asked to investigate this issue, not yet to implement the repair. Do not change the 640 policy without confirming whether it is a compact candidate-metadata invariant or only a model projection budget. Current accepted contract treats `current_context` as compact decision state and journal evidence as unbounded.

## Observer positions

- Product observer: normal Worker extension composition and implicit leader Alert target match product intent. It views 640 primarily as a model-projection budget and rejects silent truncation.
- Systems observer: the current raw candidate schemas make 640 a candidate-metadata contract. It recommends centralized write/read validation and typed gaps for old oversized records. It warned that `-ne` gives exact-source isolation but necessarily suppresses unrelated extensions.
- The operator resolved the extension-composition priority: unrelated extensions must remain available.

## Required continuation

1. Resume with `team_sync` on Team `ptb-worker-alert-context-limit` from cursor `41`.
2. Wait for Task `ptb-worker-alert-context-limit-286` to close.
3. Re-run blocked independent Task `ptb-worker-alert-context-limit-5ge` after the blocker closes. It must prove Worker implicit targeting and unchanged leader direct/announcement behavior.
4. Assign an independent verification Task for Worker launch composition. It must prove no `-ne`, exact `-e` retained, unrelated active extension tools preserved, Pi Team Bright leader-only tools absent, and Worker resource enable/disable still composes.
5. Request final product and systems observer reviews of the completed diff.
6. Run focused tests, typecheck, full suite, QA, package verification, and `git diff --check` after all production edits settle.
7. Report the 640 investigation separately. Do not claim it fixed unless a new authorized implementation Task repairs it.
8. Reconcile all Tasks and Workers, then shut down the Team.

Architecture impact is expected to be `none`: these are role projection, launch composition, and candidate-metadata hardening concerns inside existing boundaries.
