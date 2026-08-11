# Semantic-hardening final verification receipt

Date: 2026-08-11
Stage: hardening
Verified source: `1ca791f94cf165dd5075112bd08743b1d0d3eda7`
Package metadata: `@hypercarrier/pi-team-bright@0.17.0-rc.11`
Publication state: untagged and unpublished

## Aggregate

`npm run test:full` ran once on the clean exact source. It ran TypeScript and
passed 118 test files and 863 tests in 289.91 seconds. It was not rerun.

Earlier final-verification attempts did not support this result. At `d3a28f5`,
`c557cf1`, and `41a782b`, aggregate runs exposed stale fixtures or bounded
Beads/hydration timeouts. Focused repairs and independent checks preceded the
final exact-tree reservation. They do not replace this aggregate receipt.

## Local closure checks

- `npm run verify:package` passed the packed observation probe and generated-dist
  comparison.
- `npm run test:lanes` reported 118 files: 97 fast and 21 exhaustive.
- `npm run qa:agent-surface` passed one file and one test.
- `npm run qa:tool-results` passed one file and one test.
- `git-privacy-scan --ref 1ca791f94cf165dd5075112bd08743b1d0d3eda7 --base e55b4f2a9190d700a03d95cb9dee75e5c892ca0a range` passed.
- All 49 tracked JSON files parsed.
- All 275 local Markdown link occurrences resolved after stale pointers moved to
  current authoritative modules or context.
- TypeScript-AST source-graph analysis found 123 production TypeScript files,
  224 resolved runtime static local edges, zero nontrivial strongly connected
  components, and zero runtime dynamic local imports.
- `git diff --check` passed. The lead reviewed and integrated the maintained
  documentation after the exact source verification.

The aggregate and package probes cover executable public and persistence
contracts through their full-suite and installed-artifact checks. The result,
context, and Project journal now route this exact evidence.

## Limits

These are local deterministic source and package checks. They do not prove a
real Pi process, Beads/Dolt contention, external writers, watcher delivery, OS
scheduling, terminal pixels, publication, registry state, or provenance. No
tag, push, npm publication, registry query, or GitHub release occurred.

## History consolidation addendum

Shared release history through `ec7642a` remains unchanged. Later unpublished
branch commits were consolidated for review. Consolidated source
`bea6f45572ba34f5e29574cc489f45383b7ebc19` has the same
`979b1fdb89115493c5526f1644a0102a3bd7b65f` tree as the verified source named
above, so the aggregate and closure evidence still applies. Earlier transient
commit names remain historical evidence, not current revision pointers.
