# Scenario verification

Purpose: verify coordination invariants at three separate boundaries.
Scope: deterministic checks and isolated real-Pi scenarios. Live model quality is outside this method.

## Three layers

1. **TLA+** checks the bounded state machine and its mutants. Run `npm run verify:formal`. A model can expose an invalid transition. It cannot prove Pi hook timing.
2. **Unit traversal** enumerates observation-service inputs with fake stores. It covers liveness, failed reads, cursor fences, and empty journal pages. Run the focused `CoordinationObservationService` tests. Fake behavior must match the durable contract.
3. **Scripted real Pi** drives the actual agent loop through a loopback OpenAI-compatible provider. It checks extension hooks, provider context, tool execution, and persisted Session entries. It uses no remote credentials.

The unit [state traversal](../../src/coordination/sync-state-traversal.test.ts) enumerates 888 liveness rows: 0–2 Workers, five evidence states, pending actuation, visible events, Task revision changes, and zero or positive wait. Its named rows cover duplicate calls, missing baselines, native empty pages, acknowledgement failures, cursor fences, and wait transitions. Row IDs encode the input. All 925 traversal tests now assert the fixed contract, including empty-page
and Task-authority-change combinations.
The in-memory fake matches pending-slot discard, duplicate refusal, and missing-baseline snapshot behavior.

```sh
npx vitest run src/coordination/sync-state-traversal.test.ts src/coordination/sync-continuity.test.ts src/model-tool-contract/in-memory-authority-ports.test.ts
```

The [pre-fix unit evidence](../journal/artifacts/2026-10-07-team-sync-unit-traversal.txt) records 743 passing rows and 206 expected-failing rows across five files.
The [fix record](../journal/2026-10-07-team-sync-presentation-fix.md) records the passing fixed tree.

Each layer detects a separate risk. Use the smallest relevant check during an edit. Reserve the aggregate lane for the final stable tree.

## Run the team_sync scenarios

Install package dependencies with `npm ci`. Node and tmux must be on PATH.

```sh
npm run e2e:team-sync-scenarios
EXPECT=bug npm run e2e:team-sync-scenarios
```

Default mode and `EXPECT=contract` assert the fixed contract. `EXPECT=bug` asserts the known pre-fix failure. It must observe `indeterminate`; it does not turn arbitrary failures into success.

- S1: snapshot then updates in consecutive assistant turns within one Pi run.
- S2: two `team_sync` calls in one assistant message under Pi's parallel execution. A test-only extension wrapper changes only the tool's scheduling hint. Production registers the tool as sequential.
- S3: `/teamsync` publishes a framework observation; its assistant response calls `team_sync`.
- S4: a sequential gate tool forces both duplicate calls through Pi's sequential execution. RPC event order proves this mode.
- S5: a test extension removes one native result before provider proof capture. A later run must discard the unproven pending slot and permit a fresh snapshot.
- S6: a historical `indeterminate` entry renders in collapsed and expanded views. Session reload replays its exact model-visible bytes.

S2 checks parallel RPC event order. S4 checks sequential RPC event order. S6 asserts historical readability in both modes; it does not expect a failure on the pre-fix code. Unit traversal owns acknowledgement failure and empty-page cases.

The [pre-fix evidence](../journal/artifacts/2026-10-07-team-sync-scenarios-bug.txt) records six scenarios on base `337cb13` with Pi 0.83.0. Default mode fails S1 on this base, as predicted.

The runner prints JSON evidence for each scenario. It extracts results by tool call ID. It also checks that the framework observation reached the provider payload.

The harness creates a private tmux socket, temporary HOME, isolated Pi settings, and isolated Session files. Cleanup stops only those processes. Set `PI_TEAM_SYNC_TEST_RETAIN=1` to keep temporary files for diagnosis. Set `PI_TEAM_SYNC_TEST_PI_CLI` to test another Pi CLI.

## Add a scenario

Reuse `scripts/team-sync-continuity-e2e/harness.mjs`. Keep assertions in the scenario runner.

```js
const s = new ScriptedScenario();
try {
  await s.start();
  await s.prompt("Perform the scenario.");
  const [first] = await s.step(toolCallResponse("team_sync", { view: "snapshot" }));
  const [second] = await s.step(toolCallResponse("team_sync", { view: "updates" }));
  // Assert the predicted result before ending the run.
  await s.finish();
} finally {
  await s.close();
}
```

`prompt()` stops at the first provider request. `step(...calls)` emits one assistant message and stops at the next provider request. `finish()` emits text and waits for Pi to settle. Pass multiple calls to `step()` to exercise one-message duplicates. `respond(scripted)` advances one provider gate without parsing results; use it when a scenario deliberately removes or replaces JSON content. Lower-level provider and RPC classes support abort, provider failure, Session reload, and explicit request gates.

Name the failure that each scenario detects. Write its expected result before running it. Keep raw run output as evidence. Do not claim that scripted success proves live-model orchestration quality.

Architecture impact: none. These checks do not change production responsibilities or persistence.
