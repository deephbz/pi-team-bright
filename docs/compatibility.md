# Runtime and dependency compatibility

This fork is the HyperCarrier Alpha integration vehicle. The Beads adapter is
intentionally local to this fork and does not claim an upstream-compatible
`bd` dependency or a new public Pi package API.

## Verified environment

- `pi-teams`: `0.9.14`
- installed Pi host: `@earendil-works/pi-coding-agent@0.80.6` (`pi --version`)
- installed Beads CLI: `bd 1.1.0`
- repository development dependencies: `@mariozechner/pi-coding-agent@0.54.0`,
  `@sinclair/typebox@0.34.48`, TypeScript `5.9.3`, Vitest `4.0.18`

PiTeams still imports the historical `@mariozechner/*` names because Pi's
loader supplies compatibility aliases for the installed Earendil host. The
package keeps wildcard peer ranges rather than asserting an unverified major
version contract for either Pi host or TypeBox. The compatibility smoke test
for the real host is the integration test plus loading this extension through
the installed `pi`; changing those imports or pinning a new major belongs in a
separate upstream compatibility change.

## Deliberate package changes

The source never imports `uuid`, so the unused runtime dependency was removed.
The lockfile root version was corrected from the stale `0.5.1` to the package's
actual `0.9.14`, and the unused `uuid` package entry was removed. No major
dependency was upgraded and no Beads npm package was added: `bd` is an
external CLI whose availability, JSON protocol, timeout, and repository scope
are checked at runtime.

## Remaining risk

The wildcard peers and historical import aliases are still a compatibility
edge: a future Pi loader may stop aliasing them, or a future TypeBox release
may change schema types. The current checkout's full test suite passes with
the local dependency tree, while `npx tsc --noEmit` still reports pre-existing
type errors in the extension's Pi/TypeBox registration types and unrelated
terminal/predefined-team files. Those errors were not broadened into this
Alpha because doing so would touch unrelated terminal adapters.

The adapter has fake-CLI tests for unavailable, malformed, timeout, scope,
claim-race, optimistic-conflict, and retry paths, plus a real temporary
`bd 1.1.0` integration test. Beads itself does not expose a compare-and-swap
flag in the CLI used here, so post-cutover non-claim writes require an
`expected_version` and Pi clients serialize through a local task lock. The
version check is still a preflight: an external `bd` write can land after the
check and race the CLI mutation, which the adapter reports rather than
claiming true CAS.
