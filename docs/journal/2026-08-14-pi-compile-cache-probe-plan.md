# Pi compile-cache paired probe plan

Date: 2026-08-14

Status: prepared and self-tested. Architecture impact: none. This is a
benchmark-only harness. It does not change Pi Team Bright production behavior.

## Question and boundary

The question is whether Node compile-cache enablement changes fresh exact Pi
extension startup through live exact Session projection. One sample begins just
before the parent spawns package-local Pi. It ends at a valid RPC `get_state`
response that names the generated Session ID and a Session-file coordinate under
the child-owned Session directory.

Pi removes an empty Session file on shutdown. The harness therefore does not
claim durable Session persistence without a provider turn. It does not create a
Team, start an agent turn, launch a Worker, or admit a Worker.

## Design

The runner loads only `extensions/index.ts` through explicit `-e`. It disables
discovered extensions, Skills, prompt templates, themes, context files,
built-in tools, and project trust. It fences source revision, Node version,
Node compile-cache API availability, package-local Pi CLI hash, and exact
extension hash.

It creates 15 cold and 15 warm pairs. Each pair has one cache-enabled and one
cache-disabled launch in seeded shuffled order. The pairs also use a seeded
shuffle. Cold enabled samples get unique empty caches. Warm enabled samples
get one unmeasured exact launch to prime their own unique cache. The result
uses 10,000 bootstrap resamples of paired enabled-minus-disabled admission time
and records a percentile 95% interval plus sign counts.

Each private run has unique home, Pi configuration, temporary, work, Session,
and cache directories. Cache bytes and file counts are captured around priming
and measurement. The private raw bundle keeps Session IDs and paths outside
Git. The generated machine artifact is redacted.

A stale-cache fence with wrong source hashes is removed before priming. A
nonexistent CLI exercises failed-start classification and cleanup. The harness
removes every sample root and cache root after it records evidence.

## Preparation evidence

`node benchmarks/pi-compile-cache/run.mjs --self-test` passed stale-cache
invalidation, shuffled pairing, bootstrap, redaction, failed-start
classification, and cleanup checks. The unmeasured exact-extension smoke also
passed live Session projection and cleanup. It observed 1,506 cache files and
3,854,610 bytes after one enabled smoke launch. This is harness validation only,
not a paired performance result.

## Required next action

Do not run the final sample during active Team load. After Team shutdown, the
lead must run:

```sh
node benchmarks/pi-compile-cache/run.mjs \
  --confirm-team-shutdown \
  --raw-dir "$(mktemp -d)/pi-compile-cache-raw" \
  --artifact docs/journal/artifacts/2026-08-14-pi-compile-cache-paired-results.json \
  --pairs 15 \
  --seed 20260814
```

The result cannot identify causal production benefit. It only compares this
controlled process/session boundary on the sampled machine state.
