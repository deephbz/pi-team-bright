# Integrated PTB adversarial verification

Purpose: challenge the integrated model-role, framework-sync, hardening, and
doctor behavior through human-style Pi interaction in disposable Herdr Teams.
Base: `70bfe4f`. The six rebased commits end at `4437899`. The tested candidate
is `9879909`. Existing Teams and
terminal locations remain outside this campaign.

## Predictions before execution

| Lane | Hostile interaction | Required result |
|---|---|---|
| Doctor | Queue diagnosis, then begin tree navigation, compaction, fork, or reload | Old-owner context is cancelled or remains explicitly scoped; no Team mutation |
| Runtime | Abort a provider turn, reload a Worker, interrupt an owned carrier | Exact Membership and Session survive supported recovery; stale process evidence cannot acknowledge work |
| Graph | Replay an operation, reuse its ID with changed input, replace a graph during old work | Exact replay is idempotent; conflicts leave authority unchanged; only current graph work is delivered |
| Repair | Fail a check, run its bounded repair edge, then retry | New Attempt lineage gates downstream work; repair budget is enforced |
| Integrated journey | Two model roles, dependency handoff, framework update, manual model change | The lead can identify owner, next action, and evidence from authoritative results |

Each lane owns separate Team and terminal IDs. A Worker-authored Task event
proves execution. Process or pane activity alone proves no Task outcome.
Raw Session, provider, process, and terminal records stay in a private external
bundle. The final record separates actual-provider runs, scripted-provider
terminal runs, deterministic tests, and bounded formal checks.

## Rebase review

The graph, runtime, and delivery patches are unchanged. The stage-wording test
uses its stable hardening invariant. The Session adapter retains settings,
framework synchronization, and doctor registrations and lifecycle hooks.
Typecheck and 64 focused integrated tests pass.

## Execution status

Herdr execution awaits an explicit override of its installed skill's
outside-Herdr controller restriction. The Codex shell has no `HERDR_ENV=1`.
No existing user pane has been controlled. Three empirical lanes are prepared.

## Findings and changes

| Problem | Solution | LOC impact | Operator behavior |
|---|---|---|---|
| Doctor could submit old context while tree navigation or compaction was pending | Invalidate the pending doctor request at both transition starts | Included in `5fdb518`: +35/-8 across code, tests, and report | Stale diagnosis context is cancelled |
| Malformed Member records appeared as an active Team lifecycle | Report sampled entry counts without deriving lifecycle | Included in `5fdb518` above | Metadata states the evidence actually read |
| Recovery fixture never acknowledged its snapshot under the new sync contract | Emit the successful assistant turn; assert the committed cursor remains unchanged after a corrupt-authority read | `9879909`: +13/-0, test files only | No product behavior change |

Architecture impact: none. These changes enforce existing ownership and
observation contracts. They add no authority, persistence, or dependency.

## Completed evidence

- The doctor transition cases failed before the fix. All 16 doctor tests pass
  after it. Typecheck passes.
- The recovery case failed before the fixture repair and passes after it.
  It proves both a successful acknowledgement and no cursor advance on an
  unavailable authority read.
- The full 159-file inventory completes with 1,128 passing tests and four
  skipped tests. Evidence combines the unchanged passing prefix, the repaired
  recovery case, and the remaining sorted files plus the causal inventory
  case. The initial full command failed on the fixture described above; it
  was not reported as a successful uninterrupted run.
- The package verification and test-lane inventory checks pass.
- Real Pi 0.87.1 passes five continuity rounds and two recovery challenges:
  active/idle manual sync, automatic sync, empty/switch behavior, threshold
  batching, manual updated sync, provider error/abort/reload, and automatic
  failure followed by manual recovery. This harness uses private tmux and a
  scripted loopback provider. It does not prove Herdr behavior or autonomous
  model judgment.

The original checkout advanced concurrently to `4b27fd2` on
`codex/task-timeline-view`. It remains untouched. This candidate targets the
requested `70bfe4f` base and does not include the later timeline feature.
The integrated candidate is on `codex/ptb-doctor` in the existing isolated
hardening checkout. No package was published or installed over the active
extension.
