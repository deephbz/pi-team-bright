# Leader `task_create` semantic-result trace

Date: 2026-08-03
Task: `ptb-layout-invariant-3ki`
Scope: investigation only; no production files changed

## Result

The retained Pi 0.83.0 Team Sessions contain two successful leader
`task_create` calls. Each persisted the two expected Beads Tasks and returned a
validated model projection. I did not find an exact failing leader call, a raw
executor trace, or a TUI error for the reported `no semantic result returned`
incident.

The Herdr leader record points to an older native Session path that is no
longer present under the current Pi Session store. Herdr can still identify its
pane, but it cannot restore the deleted JSONL. This is an evidence gap, not
proof that the reported incident did not occur.

The current native trace has occurrences of the reported phrase in the newly
delivered investigation Task prose. Those occurrences are not tool errors.

Architecture impact: none. This is a dated investigation artifact.

## Raw evidence and successful correlation

Herdr was available (`HERDR_ENV=1`). `herdr agent list` and `herdr agent get
w4:pGZ` identified the historical lead pane and its claimed Session path. The
path was absent from the current Session store. No pane was changed.

The following retained native Pi Session JSONL records are the exact available
Pi 0.83 leader evidence. The SHA-256 values identify their complete raw source
files without copying all Session content into Git.

- `2026-08-03T07-55-08-095Z_019fc69e-8fbf-7771-90fb-6141ea88b3e1.jsonl`,
  SHA-256 `acd8e3d85e6eb6e90361cc08cbab7803447b872216b8507a80d051b660b7dc80`.
  At `2026-08-03T07:55:41.173Z`, call
  `call_osE5pU0npT3Mq0Av5zx1C4Ny|fc_02378af7a9a4db70016a70497c96248198ab05d46f5c61b463`
  submitted two bounded candidate inputs: `Verify lifecycle A` for
  `pi83-clean-a`, and `Verify lifecycle B` for `pi83-clean-b`. Its Pi tool
  result was a `task_create_batch` with two `created` outcomes. The model
  projection named `pi83-herdr-clean-075506-71p` at
  `v_0aa0243ce0cf775a` and `pi83-herdr-clean-075506-as8` at
  `v_121eb3a4a06dd1fc`.
- `2026-08-03T08-00-35-998Z_019fc6a3-909e-7b51-b92a-6292bc72494d.jsonl`,
  SHA-256 `77a14876a22d850162d1a146abbb0e2a13b0177c0b65c692c88086de011558f0`.
  At `2026-08-03T08:01:02.018Z`, call
  `call_hf8cjqAnje3P3Yt9UyfjlNmi|fc_0e37c1a2ebbb7e16016a704abd11308191af20cfd244817c81`
  submitted the same two bounded inputs for `pi83-final-a` and
  `pi83-final-b`. Its Pi tool result was a `task_create_batch` with two
  `created` outcomes. The model projection named
  `pi83-herdr-final-080025-14a` at `v_6c6bfa193d6d3214` and
  `pi83-herdr-final-080025-jpt` at `v_274051d34c69120e`.

The matching Team event sources are
`~/.pi/teams/pi83-herdr-clean-075506/events/team-events.jsonl` (SHA-256
`93e650f10aeff6eebe0251e959415b43df9a9c70576966d125281ac2fca456f1`) and
`~/.pi/teams/pi83-herdr-final-080025/events/team-events.jsonl` (SHA-256
`5b94380b63b234135c0645acb55b1b1114fb5a0f1e6e11023bbfdb2d999d2f28`). They
contain separate Task events for each created ID. Read-only owned-Beads
queries also found all four IDs with their expected Team label, candidate
metadata, creator `team-lead`, and later lifecycle history. Thus Beads mutated
once for every successful input. The retained evidence contains no retry of
either call, so it cannot prove duplicate-retry behavior.

## Boundary trace

The source tree changed after the retained Sessions. The following source facts
describe the current uncommitted tree, not a certified source snapshot for the
reported historical incident.

Facts from the current source tree:

1. Leader registration uses the candidate `task_create({ tasks })` tool
   ([`src/model-tool-contract/pi-registration.ts:151-169`]). Its executor calls
   `executors.taskCreate`, then calls `assembleCandidateToolResult`.
2. The executor calls `DurableModelToolTeamPort.createTask` once per input and
   returns a `task_create_batch` ([`src/model-tool-contract/executors.ts:102-127`]).
3. The durable port calls `CandidateBeadsTaskAdapter.createWithReceipt` and
   maps a caught Beads error to typed `task_authority_unavailable`
   ([`src/model-tool-contract/durable-model-tool-port.ts:250-265`]).
4. The adapter creates candidate metadata before the Beads write, invokes the
   authority exactly once, and creates its raw Task card from that receipt
   ([`src/model-tool-contract/beads-task-adapter.ts:272-284`]).
5. `BeadsTaskStore.create` validates candidate context before it builds the
   `bd create` command ([`src/utils/beads.ts:639-665`]). It performs a fresh
   read after mutation before it advertises a version on update paths
   ([`src/utils/beads.ts:780-796`]).
6. `assembleCandidateToolResult` first checks the raw semantic schema, then
   derives and checks the model projection
   ([`src/model-tool-contract/result-projection.ts:325-344`]). For the two
   retained calls, the persisted Pi tool result is that model projection. The
   raw executor object itself is not recorded in native Session JSONL.
7. The TUI renderer calls the same projection. An execution error renders
   `the tool did not produce a semantic result`; malformed details render the
   unsupported-result message ([`src/model-tool-contract/tui-projection.ts:130-155`]).
   No retained TUI error is correlated with either successful call.

A focused deterministic check ran the assembly boundary directly. A complete
raw `task_create_batch` produced the singleton model JSON. The same object with
`current_context` removed threw `Invalid semantic result for task_create.`.
This proves the first validation boundary for malformed raw details. It does
not reproduce a Beads mutation, because the malformed object was injected
before any executor or authority call. The focused
`npx vitest run src/model-tool-contract/result-projection.test.ts --reporter=verbose`
check also passed: 6 tests in 1 file.

## Assessment

Facts:

- The available real Pi 0.83 calls completed semantic assembly and model
  projection. Their two expected persisted Tasks exist per call.
- A malformed raw create result first fails at
  `assembleCandidateToolResult` raw-schema validation. No model content or TUI
  semantic projection exists after that failure.
- Worker Sessions do not expose `task_create`. The leader candidate registration
  is the only current public PiTeams `task_create` path. The older generic
  registration is retained as an internal Worker-receipt source, not registered
  on the leader surface ([`extensions/index.ts:558-595`];
  [`extensions/index.ts:640-653`]).
- Candidate `task_create` has no model-visible idempotency key. A hypothetical
  post-commit assembly failure would leave an operator unable to prove that a
  newly issued retry is safe from the call result alone.

Inference:

- The available evidence does not support an active current-Pi-0.83
  `task_create` semantic-result defect. The reported incident may have used a
  Session/source revision that is no longer retained, or another validation
  boundary. Do not close the incident as disproved.
- The retained code prevents the known metadata-overflow class before the Beads
  command, but it does not independently prove every future post-commit result
  shape is serializable.

## Retry policy and smallest repair

For the two exact successful calls, do not retry: each input already has one
persisted Task. For an actual `task_create` semantic-result failure, do not
blindly retry. First query Task authority using a durable operation coordinate
or a narrowly identified Task. The present candidate call has no such public
coordinate, so retry safety is not proven when a post-commit error occurs.

The smallest owning invariant is: **a leader create operation must either
return a schema-valid semantic result, or return a durable operation coordinate
that lets a retry resolve its committed Task without another create.** The
invariant belongs at the candidate create adapter/port boundary, before
`assembleCandidateToolResult`, not in the TUI.

Start with one integration test using a real temporary Beads authority:
`CandidateBeadsTaskAdapter.createWithReceipt` -> durable port -> executor ->
`assembleCandidateToolResult`. Assert one valid input makes one Beads Task and
a valid raw/model/TUI result. Then inject a failure after the Beads create and
assert a retry with the same internal tool-call-derived operation coordinate
returns the original Task, not a second Task. If that test exposes a real
post-commit gap, persist the opaque operation coordinate in candidate metadata
and pass the Pi tool call ID into the port. Do not add a second renderer-only
fallback.
