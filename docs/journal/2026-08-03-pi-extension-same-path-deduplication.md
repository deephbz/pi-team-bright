# Pi explicit-extension and discovery deduplication

Date: 2026-08-03
Task: `ptb-worker-alert-context-limit-7r4`

## Question

Does an explicit `-e` extension source and normal extension discovery load the
same Pi Team Bright file twice on the supported Pi lines?

## Evidence

I downloaded public npm packages with `npm pack --ignore-scripts` and unpacked
them under a disposable directory. The package identity and SHA-256 were:

- `@earendil-works/pi-coding-agent@0.80.10`:
  `9f2771711b8d4ebb8d59e3177026ab417bfc6caf0d4296a58de741b41e4d9c1c`.
- `@earendil-works/pi-coding-agent@0.82.1`:
  `8343ab95cbab5766f2f5d48844df8db13e772ead2e2976166cbb820a29dacb7d`.

`0.82.1` is the tested supported `0.82.x` release.

For each package, a disposable `DefaultResourceLoader` used one extension in
`<agentDir>/extensions/probe.ts` and passed the same file through
`additionalExtensionPaths` (the `-e` route). The probe increments a global at
factory load. I then repeated the test with an explicit symlink to that file,
and with a separate stale copy.

```json
{"version":"0.80.10","mode":"exact","factoryCalls":1,"extensions":1,"errors":0}
{"version":"0.82.1","mode":"exact","factoryCalls":1,"extensions":1,"errors":0}
{"version":"0.80.10","mode":"symlink","factoryCalls":1,"extensions":1,"errors":0}
{"version":"0.82.1","mode":"symlink","factoryCalls":1,"extensions":1,"errors":0}
{"version":"0.80.10","mode":"distinct","factoryCalls":2,"extensions":2,"errors":0}
{"version":"0.82.1","mode":"distinct","factoryCalls":2,"extensions":2,"errors":0}
```

The test used only disposable files and did not modify production code.

## Source trace

Both released packages have the same relevant implementation.

- `DefaultResourceLoader.reload` combines CLI extension sources before normal
  enabled resources with `mergePaths`
  (`dist/core/resource-loader.js:229-273` in 0.80.10 and `:232-273` in
  0.82.1).
- `mergePaths` resolves each path, uses `canonicalizePath`, then suppresses a
  duplicate canonical path (`dist/core/resource-loader.js:594-605` in 0.80.10
  and `:597-608` in 0.82.1).
- `canonicalizePath` uses `realpathSync` and falls back only if resolution
  fails (`dist/utils/paths.js:8-19` in both releases). Thus an extant symlink
  aliases its target for this comparison.
- Package-resource resolution has an earlier equivalent canonical-path filter
  (`dist/core/package-manager.js:2028-2049` in both releases).

## Result

Fact: Pi 0.80.10 and 0.82.1 canonicalize and deduplicate an explicit `-e`
source against the normally discovered exact file. They also deduplicate an
extant symlink alias of that file. The factory runs once.

Fact: Distinct real paths are not deduplicated, even when their contents are
identical. Both factories run. The loader explicitly retains all extensions
when they conflict and reports diagnostics only; precedence is load order
(`dist/core/resource-loader.js:401-407` in 0.80.10 and `:404-410` in 0.82.1).

Inference: Same-path duplicate loading is not a release blocker for the two
supported Pi lines. A second, stale Pi Team Bright checkout remains unsafe. It
has a different canonical path, so Pi loads both. Its registered tools,
commands, event handlers, and module-level state can compose or conflict by
load order. Keep one canonical shipped extension path per live Team process;
do not rely on Pi to identify equivalent code at different paths.
