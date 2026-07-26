# Development

Pi Team Bright is a sharing-stage Pi package. The executable public contract
lives in source types, extension registrations, and tests; this guide only
records the maintainer workflow.

```sh
npm ci
npm test
npm run verify:package
```

`@beads/bd@1.1.0` is an exact runtime dependency, not a machine prerequisite.
The Beads adapter resolves its package-local executable so extension subprocesses
do not depend on the parent Pi PATH or a separately installed global `bd`. The
package acquires a platform-native binary during a normal npm/Git install; if
that binary is missing or unsupported, the adapter reports a typed unavailable
`bd` error rather than falling back to an ambient executable. GitHub CI sets
`CI`, which makes the upstream postinstall intentionally skip that acquisition,
so [`ci.yml`](../../.github/workflows/ci.yml) fetches the official v1.1.0
linux-amd64 archive, verifies its pinned SHA-256, and materializes it at the
owned package path before tests. `npm test` type-checks and runs the suite. `npm run verify:package` builds the
observation entry point, packs the artifact, installs that tarball in a clean
temporary project, and runs CommonJS and TypeScript probes against
`@hypercarrier/pi-team-bright/observation`. Keep `pi-teams-observation/1`
stable unless its protocol is deliberately versioned.

Before opening a release PR, inspect `npm pack --dry-run --json`. The npm
artifact intentionally contains runtime sources, assets, and public operator /
agent documentation, but excludes tests, private maintainer history, and
release-process files. Do not add credentials, generated local state, or
private journal evidence to the artifact.
