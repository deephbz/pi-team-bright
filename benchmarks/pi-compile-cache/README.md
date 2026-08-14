# Pi compile-cache paired probe

This benchmark-only harness compares fresh Node Pi processes with
`NODE_COMPILE_CACHE` enabled and absent. It loads only the exact local
`extensions/index.ts` through `-e`; it disables discovered extensions, Skills,
prompt templates, themes, context files, built-in tools, and project trust.

It measures two boundaries. `process_ready_ms` ends at the first valid RPC
`get_state` response. `session_admitted_ms` ends when that response proves the generated Session ID
and child-owned Session-file coordinate match. Pi removes an empty Session file
at shutdown, so this is live exact Session projection, not durable Session
persistence. It does not make a provider request, start an agent turn, create a
Team, or admit a Worker.

Run the deterministic harness self-test now:

```sh
node benchmarks/pi-compile-cache/run.mjs --self-test
```

One unmeasured exact-extension Session-admission smoke is also available:

```sh
node benchmarks/pi-compile-cache/run.mjs --smoke
```

It proves the process/session boundary and cleanup only. It does not write a
measurement artifact or support a cache conclusion. Do not run the paired
measurement while this Team is active. After Team shutdown, the
lead must run this exact command from the package root:

```sh
node benchmarks/pi-compile-cache/run.mjs \
  --confirm-team-shutdown \
  --raw-dir "$(mktemp -d)/pi-compile-cache-raw" \
  --artifact docs/journal/artifacts/2026-08-14-pi-compile-cache-paired-results.json \
  --pairs 15 \
  --seed 20260814
```

The runner creates 15 cold and 15 warm pairs. Each pair runs one enabled and
one disabled sample in seeded shuffled order. A warm enabled sample has one
unmeasured exact launch that primes its unique cache. Each pair uses separate
home, config, work, Session, temp, and cache directories.

`--raw-dir` must be a new absolute directory outside this repository. It stores
private Session IDs, Session paths, stderr, and child outcomes with mode 0700.
The committed artifact is redacted: it has no local paths, Session IDs, or
child names. The runner removes every child work, Session, and cache directory
and records cleanup evidence. Keep or remove the private raw bundle under the
operator's evidence policy.

The result uses 10,000 deterministic bootstrap resamples of paired
enabled-minus-disabled `session_admitted_ms` differences. It reports a
percentile 95% confidence interval and a sign count. It records cache file and
byte counts plus source, Pi CLI, Node, and exact-extension fences.

The runner refuses a final measurement unless `--confirm-team-shutdown` is
present. `--self-test` exercises the interleaving, bootstrap, stale-cache
invalidation, failed-start classification, redaction, and cleanup helpers. It
is not a causal measurement.
