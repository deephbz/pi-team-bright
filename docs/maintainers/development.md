# Development

Pi Team Bright is a sharing-stage Pi package. The executable public contract
lives in source types, extension registrations, and tests; this guide only
records the maintainer workflow.

```sh
npm ci
npm test
npm run verify:package
```

`npm test` type-checks and runs the suite. `npm run verify:package` builds the
observation entry point, packs the artifact, installs that tarball in a clean
temporary project, and runs CommonJS and TypeScript probes against
`@hypercarrier/pi-team-bright/observation`. Keep `pi-teams-observation/1`
stable unless its protocol is deliberately versioned.

Before opening a release PR, inspect `npm pack --dry-run --json`. The npm
artifact intentionally contains runtime sources, assets, and public operator /
agent documentation, but excludes tests, private maintainer history, and
release-process files. Do not add credentials, generated local state, or
private journal evidence to the artifact.
