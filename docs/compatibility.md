# Runtime and dependency compatibility

This fork is the HyperCarrier Alpha integration vehicle. The Beads adapter is
intentionally local to this fork and does not claim an upstream-compatible
`bd` dependency or a new public Pi package API.

## Verified environment

- `pi-teams`: `0.11.0-hypercarrier.0`
- installed Pi host: `@earendil-works/pi-coding-agent@0.80.6` (`pi --version`)
- installed Beads CLI: `bd 1.1.0`
- package peers: `@earendil-works/pi-coding-agent@^0.80.6`,
  `@earendil-works/pi-ai@^0.80.6`, and `typebox@^1.1.38`
- repository development dependencies: TypeScript `5.9.3`, Vitest `4.1.10`

PiTeams imports the current `@earendil-works/*` host packages and the current
`typebox` package directly. The peer ranges intentionally name the verified
0.80.6/1.x compatibility line instead of relying on the deprecated
`@mariozechner/*` packages or loader aliases. The compatibility smoke test is
the integration suite plus an RPC-mode load through the installed Pi host.

## Deliberate package changes

The source never imports `uuid`, so the unused runtime dependency was removed.
The fork uses the explicit prerelease `0.11.0-hypercarrier.0` so a live
installation is distinguishable from upstream `0.9.14`. No Beads npm package
was added: `bd` is an external CLI whose availability, JSON protocol, timeout,
exact authority root, and persisted database fingerprint are checked at
runtime.

## Remaining risk

Future Pi or TypeBox releases outside the verified ranges can still change the
extension contract. The current full TypeScript check and release test suite
pass; they do not claim compatibility outside the pinned peer ranges or with a
different Beads authority schema.

The adapter has fake-CLI tests for unavailable, malformed, timeout, scope,
claim-race, optimistic-conflict, and retry paths, plus real temporary
`bd 1.1.0` integration tests. Beads itself does not expose a compare-and-swap
flag in the CLI used here. `expected_version` is optional and enforced when
supplied; PiTeams serializes one exact Membership's mutations through a local
lease, while external writers can still race after the preflight. The adapter
reports conflicts rather than claiming database-level CAS.

The dependency tree is audit-clean in this verified environment. Vitest was
raised to the first fixed 4.1.x release, and normal semver deduplication
selected patched transitive versions (`protobufjs@7.6.5`, `ws@8.21.0`,
`minimatch@10.2.5`, `picomatch@4.0.5`, and `postcss@8.5.18`) without an npm
override or a Pi host version change. `npm audit` reports zero findings.
