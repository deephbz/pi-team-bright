# Development

Pi Team Bright is a sharing-stage Pi package. The executable public contract
lives in source types, extension registrations, and tests; this guide only
records the maintainer workflow.

```sh
npm ci
npm test
npm run verify:package
```

Task authority uses the Team-scoped graph snapshot and needs no external Task
backend. Tests isolate HOME and preserve live Team stores.
`npm test` type-checks and runs only the fast, non-exhaustive lane. `npm run verify:package` builds the
observation entry point, packs the artifact, installs that tarball in a clean
temporary project, and runs CommonJS and TypeScript probes against
`@hypercarrier/pi-team-bright/observation`. Keep `pi-teams-observation/1`
stable unless its protocol is deliberately versioned.

Before opening a release PR, inspect `npm pack --dry-run --json`. The npm
artifact intentionally contains runtime sources, assets, and public operator /
agent documentation, but excludes tests, private maintainer history, and
release-process files. Do not add credentials, generated local state, or
private journal evidence to the artifact.


## Test lanes

`npm test` is fast and non-exhaustive; `test:exhaustive-only` is its CI complement, `test:full` runs everything, and `test:lanes` verifies closure. Use `test:external` for external runtime diagnostics, `qa:agent-surface` for the agent-surface artifact, and `qa:tool-results` for receipt QA. CI on Node 22/24 runs fast plus the complement and package verification; publishing on Node 24 runs full plus package verification.

## Task hydration benchmark

Run `npm run benchmark:task-hydration -- <team> [samples]` against an isolated or
review-approved Team authority. The command uses the production Team-scoped list
and exact batch hydration path. Its JSON result contains aggregate counts,
timings, and error classes only; it omits Team names, Task data, paths, and error
details. Keep benchmark evidence separate from semantic timeout contracts.
