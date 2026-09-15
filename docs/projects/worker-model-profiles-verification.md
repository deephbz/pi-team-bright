---
purpose: Evidence contract for independent ADR0014 profile verification.
scope: Point to the executable receipt and TUI checks; live Team operation and builder-owned tests remain outside this artifact.
status: Independently verified on stable working-tree source; unreleased.
---

# Worker model profiles: verification evidence

[Decision 0014](../decisions/0014-worker-model-profiles.md) owns intent.
[Worker model profiles](worker-model-profiles.md) owns the project contract.
The executable procedure lives in:

- [`scripts/worker-model-profiles-canary/assert.mjs`](../../scripts/worker-model-profiles-canary/assert.mjs)
  — receipt schema and acceptance assertions;
- [`scripts/worker-model-profiles-canary/tui-guidance.test.ts`](../../scripts/worker-model-profiles-canary/tui-guidance.test.ts)
  — independent collapsed/expanded TUI checks;
- [`scripts/worker-model-profiles-canary/adversarial-boundary.test.ts`](../../scripts/worker-model-profiles-canary/adversarial-boundary.test.ts)
  — direct production-boundary checks for aliases, settings precedence, registry evidence, reuse, defaults, and refusal state;
- existing canary runners under [`scripts/`](../../scripts/) — isolated Pi and
  Herdr carrier setup.

Run the receipt verifier after a live canary:

```sh
node scripts/worker-model-profiles-canary/assert.mjs \
  --raw-dir /private/run-root \
  --receipt /private/run-root/receipt.json
```

Run the independent TUI check from the package root:

```sh
npx vitest run scripts/worker-model-profiles-canary/tui-guidance.test.ts
```

## Acceptance evidence

The receipt is an input manifest only. The verifier derives claims from the
private files named by `evidence`: profile settings JSON, native Worker Session
JSONL, Team snapshots and events, raw tool-call/result records, provider-request
capture, exact carrier records, cleanup inventory, and separate TUI exports.
Self-authored pass booleans do not satisfy an assertion. A synthetic fixture can
check parser shape only; it is not runtime evidence.

The receipt verifier requires evidence for:

- two distinct configured and authenticated profiles with full provider-local
  model IDs, thinking levels, usage text, and no `default_profile`;
- compact alias discovery in create/snapshot and no catalog in updates;
- invalid alias refusal before durable logical Worker, Membership, carrier,
  Session, or Worker provider-request creation;
- cleanup of disposable settings and aggregates after invalid-alias refusal;
- a model-less dependency DAG with Worker-authored Task transitions and derived
  dependency order;
- same-alias reuse without a new Session, process generation, carrier, or
  Worker provider request;
- conflicting alias refusal without state change;
- same-Session recovery after stopping the exact carrier without `worker_stop`,
  with native `model_change` and `thinking_level_change` evidence preserved and
  a later Worker-authored Task;
- collapsed TUI settings guidance without the JSON example, expanded guidance
  with one usable `model_profiles` example, and no human guidance in model JSON;
- exact disposable process and pane cleanup, unchanged global settings, and a
  recorded and hashed private location for retained Team/Session evidence before
  deletion under the private retention policy.

The verifier rejects credential-bearing keys and prints only pass/fail names.
Raw provider payloads, Session JSONL, Team files, panes, process IDs, private
settings, and auth references stay outside Git. Tracked content must contain no
credential values or personal machine values. Inspect the raw evidence behind
the receipt before accepting a result.

## Results

- Independent focused suites passed: 2 files and 9 tests.
- Equivalent full configuration passed: 145 files, 1,042 tests, 1 skipped file,
  and 2 skipped tests. `test:full` was not used because its package-local
  Vitest entry is absent in this hoisted environment.
- The late-delta focused tests passed: 4 affected files and 61 tests, one
  verifier-owned prepared-retry test, 16 bound-recovery contract tests, and
  22 exhaustive launch-compensation tests. They cover explicit untrusted leader
  cwd/trust through snapshot and ensure paths, profile catalog shadowing,
  prepared-retry thinking, and bound recovery flag omission.
- `test:lanes` reported 148 total, 125 fast, and 23 exhaustive tests.
  `qa:agent-surface` passed 2 tests. Typecheck and canary syntax checks passed.
- The private-index package gate passed after the observation build. The retained
  receipt verifier passed, and both recovery negative fixtures passed.
- The isolated Team passed native profile, reuse, conflict refusal, invalid
  alias refusal, model-less DAG, Worker-authored Task, and same-Session recovery
  checks. The private run root retains the raw evidence and cleanup inventory
  outside Git.

## Limitations

A passing receipt proves only the listed working-tree source, profile fixture,
provider run, and isolated Team. It does not prove a published npm artifact,
HyperCarrier integration, or general model availability. Native Session
records prove runtime model and thinking selection. The TUI receipt exports use
production projection output; the focused TUI suite covers success, refusal,
unavailable, expanded settings, and model-facing JSON scenarios. The recovery
negative-fixture tests use the retained private run and skip when it is absent;
they do not provide independent coverage in a fresh checkout. The prior
1,042-test full lane and live E2E remain applicable where these late deltas do
not change their semantics; neither was rerun. No global setting, auth material,
or existing coordination Team changed.
