# RC.7 publication continuation handoff

Date: 2026-08-05
Status: npm and GitHub prerelease published; final repository receipt commit and parent composition updates remain

## Published authorities

- Release source: `5bff63986f51581ae96555aa18b91c1f90723e9f`.
- Annotated tag: `v0.17.0-rc.7`, peeled to the release source.
- npm: `@hypercarrier/pi-team-bright@0.17.0-rc.7`.
- npm `next`: `0.17.0-rc.7`; `latest`: `0.17.0-rc.1`.
- GitHub prerelease: <https://github.com/deephbz/pi-team-bright/releases/tag/v0.17.0-rc.7>.
- Exact-source CI: run `30991108929`, passed on Node 22 and 24.
- Publish dry run: `30991493190`, passed at the release source with publication skipped.
- Tagged OIDC publication: `30991800392`, passed all gates and npm publish.

The registry tarball is byte-identical to the clean detached local tarball. Both
have 84 files, 205,148 packed bytes, 880,747 unpacked bytes, npm shasum
`0e0a9c90400e1374b15646314c9543b0fea722ad`, integrity
`sha512-R3ke/M+ADas5hSwDEOi/DaDO7/RX6RcVnj6OUE/Z0EIvWZUb7zgtw3/FjYFFJeaBHhXsBPblwEVkEst0DeED+w==`,
and SHA-512
`47791efccf800dab39852c0310e8bf0da0ceeff457e917159e3e8e504fd9d0422f59951bef382dc37fc58d814525e6811e15ec04f6e5c0456412cb740de103fb`.
The package-manifest SHA-256 is
`557246f555f417f5f799a90dceccff26456ff0389f249c52aca2585c73ed706b`.

npm exposes publish and SLSA attestations. Both subjects carry the recorded
tarball SHA-512. SLSA identifies repository `deephbz/pi-team-bright`, workflow
`.github/workflows/publish.yml`, ref `refs/tags/v0.17.0-rc.7`, the exact source,
and run `30991800392`.

## Aborted rc.6 evidence

A coordinator created and pushed `v0.17.0-rc.6` before the final release-source
hygiene review. Its publish run `30990508968` was canceled during `test:full`;
package verification and npm publish were skipped. No rc.6 npm package or
GitHub Release exists. The tag remains immutable. Rc.7 restores the generic
generated-dist verifier and tracks the generated `TaskVersionRef` dependencies.

## Current repository state

`docs/journal/2026-08-05-v0.17.0-rc.7-release-receipt.md` was rewritten with the
final CI, package, registry, provenance, privacy, and GitHub evidence after the
release source commit. That receipt update is not yet committed. The evergreen
`docs/current/README.md` still says npm `next` points to rc.5 and calls rc.7
prepared; it must be corrected to published rc.7 and dated 2026-08-05.

Staged and post-baseline range privacy gates passed for the release source. The
required full-history scan reported only grandfathered pre-baseline findings;
private receipts remain outside the repository. Use the approved public handle,
noreply email, and explicit UTC author and committer dates for the final docs
commit because the shell timezone is not implicitly UTC.

Architecture impact: **none**. All release-prep Teams are shut down. The
unexpected release coordinator is stopped and must not resume.

## Immediate continuation

1. Update `docs/current/README.md` to record published rc.7, npm `next`, the
   GitHub prerelease, and pointers to the aborted rc.6 and published rc.7
   receipts.
2. Review the final receipt/current-doc diff only. Run `git diff --check`, stage
   those publication records, run the staged privacy gate, and commit through
   normal hooks with UTC author/committer dates.
3. Run the post-baseline range and required full-history scans on the new tip,
   then push `main`. Do not retag or republish.
4. Confirm local and remote main match and the package repository is clean.
5. Continue the owner-authorized integration order: update HyperCarrier to the
   exact Pi Team Bright release/final-receipt commit, update its compatibility
   evidence, then regenerate and verify HyperCarrier-alpha. Preserve unrelated
   parent working-tree changes and use clean worktrees when required.
