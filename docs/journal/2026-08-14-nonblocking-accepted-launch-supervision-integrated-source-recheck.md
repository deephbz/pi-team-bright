# Nonblocking accepted-launch integrated-source recheck

Date: 2026-08-14

Status: completed benchmark correction. Architecture impact: none. The
prototype remains rejected for production use.

## Correction

The original raw result at
[`artifacts/2026-08-14-nonblocking-accepted-launch-supervision-results.json`](artifacts/2026-08-14-nonblocking-accepted-launch-supervision-results.json)
recorded the planner in source commit `45cad03`. It observed `reuse` for a live
prepared carrier. That raw record remains unchanged historical evidence.

This recheck rebased the experiment commits onto integrated production source
`1fdac31`. Its live planner check returned `refuse` with reason `unbound_live`.
The benchmark now records returned values as observations and uses only named
boolean safety assertions for pass or fail. Therefore a changed diagnostic does
not make a safe run fail, but the integrated safe refusal is required.

## Evidence

The new raw artifact is
[`artifacts/2026-08-14-nonblocking-accepted-launch-supervision-integrated-source-recheck.json`](artifacts/2026-08-14-nonblocking-accepted-launch-supervision-integrated-source-recheck.json).
It records clean source revision `17e5c47`, the integrated source hashes,
fresh isolated children, and all nine adversarial cases.

All seven accepted-and-bound samples and all seven stable-reuse samples passed.
All nine adversarial cases passed once. The live-unbound timeout sample recorded
`refuse` and `unbound_live`; its `integrated_source_refuses_live_prepared_carrier`
assertion passed. The aggregate safety result is true.

The accepted response measured 12.130 ms p50 and 36.362 ms p95. Exact later
binding measured 8.728 ms p50 and 29.159 ms p95. Bound stable-Worker reuse
measured 5.990 ms p50 and 14.387 ms p95. These remain synthetic-carrier
measurements. They do not measure a live Herdr accepted-start command or full
Worker startup.

## Result

The integrated planner now has the required safe behavior: a live prepared
carrier is refused, not reused. Keep exact Session binding as the only admission
gate. Keep the prototype out of production because the installed Herdr contract
still has no accepted-start operation.

Run this source-coupled recheck from the package root:

```sh
bun benchmarks/nonblocking-accepted-launch-supervision/run.ts --samples 7 --adversarial-samples 1
```
