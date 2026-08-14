# Warm activation prototype

This directory is a disposable experiment. It does not change Pi Team Bright
production behavior.

Run the benchmark from the package root:

```sh
./node_modules/.bin/ts-node --transpile-only benchmarks/warm-activation/run.ts \
  --samples 7 \
  --pane <exact-owned-source-pane-id>
```

The runner writes its durable result to
`docs/journal/artifacts/2026-08-14-warm-activation-machine-results.json`.
Use `--artifact <path>` for a smoke result outside the repository.

The `--pane` value is required for the Herdr carrier experiment. Use an exact
pane you own. The runner queries Herdr first. It creates only child panes from
that pane and closes those child panes. Do not use a UI-focused pane by guess.

The runner uses private temporary Pi homes, Session directories, project
fixtures, and probe records. It sends no model prompt and uses offline mode.
The committed JSON keeps each timing and derived invariant. It excludes paths,
Session IDs, process IDs, credentials, prompts, and provider payloads.

The mechanisms are:

- persistent local RPC Session replacement;
- in-process SDK `AgentSessionRuntime.newSession()` reuse;
- a reserved unbound Herdr pane with a local command and graceful shutdown;
- a fresh one-shot Node process that imports Pi main before activation; and
- a Bun-bundled, preloaded Pi Team Bright factory passed to `main()`.

The SDK initial-Session number is process-warm. The runner imports Pi before it
sets each sandbox environment. It does not measure Node startup or module import
cost. The inline factory path requires `bun` in `PATH`. It records `not_run` when
Bun is unavailable.

The p50 and p95 use nearest-rank successful samples. A command in an unbound
pane is carrier evidence only. It is not a Membership bind, readiness signal,
progress signal, or Task authority result.
