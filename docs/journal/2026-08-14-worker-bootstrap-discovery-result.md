# Fresh Worker Pi bootstrap and resource-discovery result

Date: 2026-08-14
Stage: exploration measurement inside the hardened Task-first package
Architecture impact: none. This change adds only a disposable benchmark.

## Question and scope

The question was whether resource-discovery switches or a bundled exact
extension improve fresh Pi bootstrap without changing Worker resource or tool
semantics. The full problem and data graph are in
[`worker-bootstrap-discovery/plan.json`](../../benchmarks/worker-bootstrap-discovery/plan.json).

The runner creates no Team, Membership, Task, or production state. It measures
an offline Pi RPC child from parent process spawn to the exact successful
`get_state` response. It records shutdown after that response separately.
Every sample has a fresh temporary home, Pi agent directory, session directory,
and project cwd. The exact extension source was
`bcf57707b9bc546e5e754681db7d29e6bd094fea`. The fences were Pi `0.83.0` and
Node `v25.6.0`.

The raw, redacted result is
[`2026-08-14-worker-bootstrap-discovery.json`](artifacts/2026-08-14-worker-bootstrap-discovery.json).
It contains 80 successful samples, ten per case, in rotated round-robin order.
Each child exited before its fixture was removed.

## Result

The earlier timing result was defective. It calculated RPC-ready elapsed time
after child shutdown. This correction captures a monotonic timestamp at the
successful `get_state` response and records shutdown separately. Do not use the
superseded values.

The normal exact-extension launch retained the unrelated discovered extension,
its active custom tool, and its unrelated Skill in all ten samples. It reached
RPC readiness in 447.806 ms p50 and 460.567 ms p95. Its probe reached
`session_start` at 435.490 ms p50 and `resources_discover` at 437.794 ms p50,
measured from child Node process start. Each post-response shutdown is a
separate raw field, `shutdown_after_rpc_ms`.

No exclusion is a safe general production candidate. `--no-extensions` removed
the unrelated extension and its tool. `--no-skills` removed the unrelated Skill.
The all-disabled case removed both. `--no-context-files` removed the fixture
context and is only policy-compatible where the existing Worker aggregate
prompt deliberately replaces context-file discovery. It reached 445.154 ms p50
and 484.038 ms p95, so it did not improve the result.

Prompt-template and theme fixture semantics are explicitly unmeasured. Pi's
public RPC and extension APIs did not expose their loaded-resource state in this
benchmark. Their exclusion cases measured 442.410 ms and 457.374 ms p50, but
must not be treated as resource-policy-safe candidates.

The Bun-bundled exact extension preserved the tested unrelated extension, tool,
and Skill. It reached 420.081 ms p50, but its p95 was 1367.364 ms. It has no
binding proof and is not a candidate.

The duplicate test installed a second discovered copy of the exact Pi Team
Bright extension while also passing the exact extension with `-e`. Pi exited
with a duplicate-registration failure. This proves that suppressing unrelated
discovery is not a correct duplicate remedy.

The safe ranking is therefore: keep the current exact extension plus normal
discovery. There is no measured safe optimization from these switches. The
conditional existing aggregate-prompt use of `--no-context-files` remains a
policy behavior, not a speed result.

## Boundaries and missing phases

The runner separates parent spawn-to-RPC-ready from shutdown and records probe
module, factory, `session_start`, and `resources_discover` phase ends. The
probe module appears only after Pi imports and loads the exact extension. Pi
exposes no earlier public lifecycle timestamp, so this result cannot divide
process spawn, Pi import, and exact-extension load further.

There is no durable Membership in this harness. Exact binding and first
no-model Task delivery are explicitly `not_attempted`, not inferred from RPC
readiness. RPC mode also cannot observe Herdr `interactive_ready`. This result
does not make a Worker-ready or 100 ms claim.

## Required follow-up work

Pi needs a public startup trace with monotonic phase timestamps for process
entry, Pi import, extension discovery/load, session creation, `session_start`,
and resource completion. It should expose a redacted loaded-resource manifest
so a harness can prove prompt-template and theme retention, not only successful
startup.

A bundled-extension path needs a reproducible package artifact, source digest,
and extension-identity policy. It must prove equivalent Worker binding and Task
delivery before it can replace exact-source loading. The present Bun bundle has
a worse tail and no binding proof.

Pi Team Bright needs an explicit Worker resource manifest if it will exclude
any normal resource class. The manifest must name retained unrelated resources
and state the aggregate-prompt exception. It must reject a second Pi Team Bright
extension by identity before registration, rather than use `--no-extensions`.

A separate real-Worker canary must measure process spawn, exact Session binding,
first no-model Task delivery, and Herdr `interactive_ready` under the same
resource profile. It must retain the current Membership and process-generation
fences.
