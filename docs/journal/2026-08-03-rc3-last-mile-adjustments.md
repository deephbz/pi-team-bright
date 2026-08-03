# Pi Team Bright rc.3 last-mile adjustments

Date: 2026-08-03

The owner added three final instructions before publication:

1. Raise the model-tool Task `goal` maximum from 160 to 1,000 TypeBox
   string-length units.
2. Keep successful human tool results concise and semantic, but show execution
   or result-projection failures as a clear, copyable raw `content` and
   `details` report. Do not replace the source failure with a generic missing-
   semantic-result message.
3. Keep work in this repository solo by default. Product and systems observers
   are optional unless the owner or an assigned Task explicitly requests them.

The goal limit is one Task-card contract across create input, raw Task cards,
and model Task-card projections. Boundary tests cover 160, 161, 1,000, and
1,001 units. The error renderer identifies the tool and error class, preserves
raw result data, and tells the operator to review sensitive fields before
sharing. Successful rendering remains allowlisted and compact.

Verification after these adjustments:

- focused catalog and result-projection lane: 2 files and 18 tests passed;
- TypeScript typecheck passed;
- generated contract HTML refreshed;
- agent-surface QA passed after the goal-schema change;
- tool-result QA passed after the error-renderer change and refreshed
  `artifacts/tool-result-qa/latest.json`;
- test-lane closure passed with 69 files: 51 fast and 18 exhaustive;
- packed observation package probe and generated-dist comparison passed;
- `git diff --check` passed.

The earlier exact-tree aggregate evidence no longer covers these last focused
changes. Do not repeat it locally. The required GitHub Actions dry-run and OIDC
publish workflow will run `test:full` on the final commit.

Architecture impact: **changed** at the existing public Task schema and human
result-projection contracts. No component, authority, dependency, data flow,
store, trust boundary, process boundary, or deployment topology changed. Keep
the Structurizr DSL unchanged.

## Publication continuation after final commit

The complete source bundle was committed on `main` as
`50531aacb40d43baaa7eec269588d711ee47ecd7` with the approved `deephbz`
GitHub noreply identity and UTC author/committer timestamps. The working tree
was clean and the branch was two commits ahead of `origin/main` immediately
before this handoff. Do not amend or replace the commit unless a new defect
requires it.

The staged privacy scan passed before commit. The final release-range scan from
the configured baseline through `50531aac...` passed; its receipt is outside
the repository at
`/tmp/pi-team-bright-release-range-privacy.kggIq4`. The required full-history
scan was also run against the final commit. It reports only grandfathered
pre-baseline commit-identity/timezone findings before its 100-finding limit;
the repository's already-public history cannot be rewritten under the release
policy. The current index likewise contains grandfathered pre-baseline fixture
or image findings. Do not print detected values. Preserve the full-history
receipt outside the repository at
`/tmp/pi-team-bright-release-history-privacy.JaPy0B`.

The owner explicitly changed this repository's work rule: small and major work
stays solo unless the owner or an assigned Task requests product or systems
observers. `AGENTS.md` now contains that specific override. The earlier goal-
limit review Team completed and shut down before this rule changed.

Remaining release work:

1. From a clean detached checkout of `50531aac...`, pack once, record the new
   npm shasum/integrity and SHA-512, and install that exact tarball in an
   isolated project. The old package hashes in the earlier handoff are stale.
2. Run a bounded no-model Pi RPC package-load canary from an unrelated working
   directory. Use the exact installed tarball package, a disposable Pi agent
   directory, and `get_commands` or an extension command. Do not repeat the
   prior `pi -p` canary that waited on a model turn.
3. Push `main`, then follow `docs/maintainers/releasing.md`: dispatch the GitHub
   Actions OIDC workflow with `dry_run=true` and record its exact SHA and
   skipped publish step.
4. After the dry run passes, create and push annotated tag
   `v0.17.0-rc.3` on `50531aac...`. Dispatch the tagged workflow with
   `dry_run=false`, `tag=next`, and a unique nonce.
5. Verify workflow success, exact commit, npm `0.17.0-rc.3`, `next`, tarball
   bytes, integrity, provenance, GitHub tag/release evidence, and write the
   durable release receipt.

Do not run `test:full` locally. The prior local aggregate passed 69 files and
542 tests before the final focused changes. The GitHub dry-run and publish
workflow each run the final aggregate. Do not publish locally; local npm auth is
unavailable and GitHub Actions OIDC is required.

## New release-blocking investigation request

Before publication, investigate Team `rc-stress-16` solo. The owner reports a
large cluster of the old TUI message `Execution error: the tool did not produce
a semantic result` during a 16-Worker stress test. Treat the raw Team/Task and
Pi Session records as evidence. Determine the first failing tool/result shape,
separate execution failure from renderer masking, quantify the repeated pattern,
and identify the smallest owning invariant. Do not assume the new raw-error TUI
renderer fixes the underlying semantic-result defect; it only makes future
failures reportable. Add a focused reproduction and verification anchor before
deciding whether `50531aac...` needs a repair commit. Publication is blocked
until this investigation resolves or explicitly classifies the failures as an
old-version-only artifact.

The investigation found 92 persisted rc.2 Pi Team tool errors behind the generic
renderer line. None was a Pi Team semantic-result or model-projection validator
failure. The underlying results were 28 rejected compound claims and 64 Beads
timeouts. The Team config proves that the run loaded `0.17.0-rc.2`, and the owner
confirmed that the observed messages came from the old extension. The rc.3 raw-
error renderer test is the focused release anchor, so this old-version-only
message does not block rc.3 publication. Preserve the separate contention result
as capacity evidence; do not claim a passing rc.3 16-Worker stress gate.

The sanitized result is in
`docs/journal/2026-08-03-rc-stress-16-investigation.md` and its machine-readable
artifact. Commit this handoff update with that result before release.
