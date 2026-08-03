# First model-tool vertical slice

Date: 2026-08-02

Status: verified in-process tracer; not registered by the shipped extension

Architecture impact: none. The tracer is an unregistered internal module with a
preliminary in-memory authority. It changes no accepted component boundary,
persistence boundary, deployment, or public extension behavior.

## Result

The accepted `team_create` → `ensure_worker` → `team_sync({view:"snapshot"})`
path now executes through:

1. exact Pi Session identity from the registration context;
2. candidate TypeBox parameter schemas;
3. asynchronous executor and Team-port boundaries;
4. a preliminary in-memory Team/Worker authority;
5. one validated semantic result; and
6. minified named JSON in model `content` plus the same canonical object in
   machine `details`.

The port keeps logical Team identity, Team-name uniqueness, and exact
Session-to-active-Team binding distinct. A logical Worker is keyed by Team and
Worker name. Because this slice launches no carrier, it reports
`carrier:"absent"` and creates no Tasks.

## Verification

- `npm run typecheck` passed.
- `npx vitest run src/model-tool-contract/catalog.test.ts src/model-tool-contract/first-journey.test.ts`
  passed two files and nine tests.
- `npx ts-node --transpile-only scripts/probe-model-tool-vertical-slice.ts`
  returned `status:"passed"`, final revision `2`, and the exact three registered
  tool names.
- `npm test` passed 45 files and 367 tests before the test file was renamed from
  the misleading exhaustive-lane suffix; the focused suite passed after the
  rename.
- `npm run test:lanes` now passes this tracer test and stops only at the unrelated
  unclassified `src/utils/worker-resource-extension.contract.test.ts`.

## Review

The product observer accepted this exact claim:

> The accepted create-Team, create-or-reuse-logical-Worker, and snapshot
> contracts execute end to end through the Pi registration adapter against a
> preliminary in-memory port. Exact Session identity isolates the Team, and
> validated results reach content as minified named JSON.

The observer rejected claims of a staffed or ready Worker, Task delegation,
updates, persistence, real Pi/provider execution, public registration, or
production readiness. The slice proves wiring and identity boundaries, not yet
the Task-first product promise.

The systems observer required three corrections before commit. The Team port
and executors are now asynchronous, Session fixtures use opaque Session IDs
rather than file paths, and a malformed semantic result test proves validation
fails before model content assembly.

## Next evidence

Run a non-public real-Pi canary with the candidate registration. Capture the
actual provider-visible schemas and use two real Session IDs. A blind model must
create one Team, ensure one logical Worker, read its snapshot, preserve
`carrier:"absent"`, and invent neither readiness nor Task assignment.
