# Worker model-registry optimization continuation

Assigned Task: `ptb-worker-startup-opt-zfv`.

The Task is assigned and ready at version `v_044f2337b2b9f73b`. The Worker attempted a normal claim, but the legacy Task mutation surface rejected it because graph-native revision application is unavailable. This is the known mixed-version coordination condition. The lead directed source work to proceed.

Goal: remove the first new-Worker configured default-model catalog subprocess. The pre-actuation artifact measured `resolveQualifiedWorkerDefaultModel` at 771.512 ms p50 and 863.020 ms p95 because it invokes `pi --list-models`.

Owning distinction: the exact model-tool invocation already has a `modelRegistry`. Capture only a payload-light set of qualified available model keys from that exact ensure context. Use it only when the caller explicitly requests a new Worker and the configured Worker default-model branch applies after Team precedence. Do not persist it, add a TTL cache, expose it to the model, or revalidate a recovered Membership model. Keep the subprocess fallback only when the exact registry snapshot is unavailable.

Required evidence: first-call registry validation must make no subprocess call; an invalid key must refuse before Membership or carrier creation; precedence and snapshot-unavailable fallback must remain correct; no catalog values may leak into model output. Add focused timing evidence and a final journal result. Architecture impact is expected to be none.

No source changes for this Task were made before this handoff. The current committed base is `35c7efd`.

## Result

The model-tool registration now captures only a `ReadonlySet` of qualified
available model keys from its exact `modelRegistry`. The set is invocation
local. It is not stored in bindings, Team state, Membership state, a cache, or
tool output.

The launch bridge uses it only when a new Worker has no explicit or Team
default model and a configured Worker default applies. It validates that
configured value before Membership creation. A recovered Membership keeps its
captured model and does not revalidate it. An absent or failed registry snapshot
keeps the existing `pi --list-models` fallback.

Focused tests prove no-subprocess snapshot validation, fallback only when the
snapshot is unavailable, invalid-key refusal before Membership or carrier
creation, explicit and Team precedence, recovery without revalidation, exact
tool-context capture, and result projection without catalog keys.

The machine artifact is
[`2026-08-14-worker-model-registry-benchmark.json`](artifacts/2026-08-14-worker-model-registry-benchmark.json).
It records five local samples. The CLI validation distribution was 3270.9278 ms
p50 and 4464.1951 ms p95. The in-process snapshot capture and validation
was 0.1255 ms p50 and 0.8831 ms p95. The Task's earlier pre-actuation artifact
reported 771.512 ms p50 and 863.020 ms p95 for the production resolver. The
new machine samples measure only this removed resolver stage, not end-to-end
Worker creation.

Verification passed: `npm run typecheck`; focused worker-resource and durable
model-tool tests; the exhaustive launch-compensation contract file; and the
benchmark syntax and JSON checks. Architecture impact: none.

Residual risks: a missing or failed runtime snapshot takes the intentional slow
CLI fallback; a runtime catalog can change after capture, so unavailable
settings refuse before actuation; and the benchmark does not measure full
carrier startup.
