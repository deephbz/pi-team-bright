# Formal hardening adversarial check

Base: `0d4389d98cf5044bdd67b07fed82e01c304b6e9c`. The current shared tree had uncommitted hardening edits during the check. The test source is under `test/formal-adversarial/`. These tests compare caller-visible outcomes with independent safety claims. They do not prove TypeScript refinement of the TLA+ models.

## Bounded traces and counterexamples

- The graph search ran all `6^4 = 1,296` four-action words over claim, success, failure, and semantic revision for a two-Task dependency. It checked each refusal left the snapshot unchanged. It checked accepted prerequisite Attempt lineage before and after recovery. The durable CAS test raced two claims from one Task version. One claim committed, one refused, and recovery found one Attempt.
- The special-key test used `__proto__` as a valid prerequisite Task key. Base lost its Attempt binding. The current tree preserves the own property and the accepted Attempt ID. A disposable mutant dropped that key from `Object.fromEntries` in `graph-control.ts`; the same test failed as expected.
- The publication tests used real graph snapshots, pending delivery records, retirement fences, and Team events. Six tests failed on a disposable archive of the base. They cover a missing graph snapshot under an existing fence; an old delivery after authority replacement and retirement failure; replacement between delivery selection and final send; an old graph operation replay after a newer revision; a missing Task event after a current operation replay; and special-key lineage. A controlled overlap let an older committed Task event arrive after the newer event. The raw journal kept that history. `CoordinationObservationService` returned only the current Task version in `team_sync` changes, and the retirement fence stayed newer. The current tree passed all ten adversarial tests.
- The exact Membership test observed `m-old` and its Session, replaced the config with `m-new` and a new Session, then attempted the old action. The old action did not run. The new exact pair ran. The existing paged-observation regression in `src/model-tool-contract/durable-model-tool-port.test.ts` passed: a partial Task hydration returned unavailable and left the cursor at `0`.

## Model-to-code trace map

| Model action trace | Executable boundary and observed check |
| --- | --- |
| `ClaimA → AchieveA → ClaimB → ReviseA` | `GraphTaskController.applyGraph`, `transition`, `readAttempts`, and `recover`; the bounded test checks B cannot retain an accepted Attempt from superseded A. |
| `Acquire(m-old, session-old) → Replace → Write` | `DurableTaskChangeDeliveryMembership.withCurrentRecipient` calls the exact Session binding guard; the stale action refuses. |
| `Commit1 → QueueDelivery1 → Commit2 → RetireFails → Deliver` | `DurableGraphTaskOrchestration.applyGraph` commits the new snapshot. `TaskChangeDelivery` reads pending delivery and rechecks before send. The test inserts replacement at that boundary and requires no old-version payload. |
| `Commit → publication failure → exact replay` | `publishTaskMutation` fails before Team event append. Exact replay must add the missing event for the current Task coordinate. |
| `ReadPartial → Stage` | The existing paged-observation test forces incomplete Task hydration. It requires no staged result and no cursor advance. |

The overlap trace permits a late historical Task event. The observation service filters it by exact current Task version. Raw event order does not assert authority currentness.

The bounded graph alphabet excludes cancellation, arbitrary DAGs, and longer repair loops. The Membership test checks stale binding after a completed replacement; it does not prove lock fairness or process liveness. The publication checks cover injected failures and controlled interleavings. They do not prove exactly-once external delivery.

Raw runs were retained outside the source tree as `baseline-final.log` and `mutant-special-key.log`, alongside the disposable source copies. Architecture impact from this test contribution: none.
