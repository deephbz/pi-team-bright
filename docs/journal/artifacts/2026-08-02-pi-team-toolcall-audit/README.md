# Pi Team Bright real-session tool-call audit

Date: 2026-08-02

Status: point-in-time audit of two still-running Teams. No product code changed.
Architecture impact: none.

## Scope and verdict

The audit covers these Teams:

- `rarebit-public-release-e2e`, from 00:30:38Z through 05:23:32Z.
- `worker-resource-projection-review`, from 00:37:05Z through 05:23:30Z.

It includes 646 Pi Team Bright calls from 12 configured Session files. It excludes all other tools and other Team names.

Here, “Rarebit Team” means the Pi Team Bright Team named `rarebit-public-release-e2e`. It never means Rarebit Summary content or the Rarebit TUI projection.

The concern is valid, but long waits are not the main fault. Most 300-second waits correctly use event-driven synchronization. The largest faults are projection design and model visibility.

The audit found five product issues and one repeated caller error:

1. Projection continuations are not visible to the model.
2. `team_sync` hydrates unrelated Task history and can lose the whole result to Beads contention.
3. Routine wait interruption becomes an error.
4. `claim` permits an intuitive call shape that its implementation rejects.
5. Task history and idle-Worker advice grow without useful bounds.
6. The Rarebit lead used `limit: 20` after the Team exceeded 20 projection records.

Fourteen calls ended as errors: six claim-shape errors, six interrupted waits, and two Beads timeouts. Two other updates returned correct stale-version refusals. Two waits were still active at the cutoff.

## Findings

### 1. Projection continuation is an impossible model action

Severity: critical.

Observed: 105 `rarebit-public-release-e2e` Team `team_sync` results had a truncated Worker/Task projection. No later call supplied `continuation` (`metrics.json`). The first audited truncation starts at the lead Session's lines 1968-1969.

The tool puts the continuation token only in `details.nextActions`. Its model text says only “echo the returned continuation” (`extensions/index.ts:2031-2052`).

Pi 0.83 defines `content` as model input and `details` as log or UI data. The installed types state this directly (`pi-agent-core/dist/types.d.ts:311-314`). The OpenAI Responses adapter converts only `msg.content` (`pi-ai/dist/api/openai-responses-shared.js:203-205`).

Assessment: the model cannot perform the requested next action. The zero continuation calls are expected from this contract.

The lead also chose `limit: 20`. The Team reached 62 Worker/Task records. A temporary caller fix is `limit: 100`, but the tool must still expose continuation arguments in model content.

Change:

- Put the exact continuation token in model-facing content.
- Prefer a compact, structured next-action block in content.
- Scope projection Tasks to requested `task_ids`, nonterminal Tasks, or an explicit projection mode.
- Do not require full projection paging before an event wait when the caller requested one Task.

### 2. Full Task hydration causes latency and typed-result loss

Severity: high.

Observed: 151 Rarebit waits and 77 Worker-resource waits requested selected Task IDs but received a broader projection (`metrics.json`). The broader projection drives large Beads reads.

Two Rarebit `team_sync` calls failed after about ten seconds. Each error shows one `bd show` command with 40 or more Task IDs:

- `release-implementer` Session lines 372-373.
- `parent-docs-implementer` Session lines 28-29.

Four direct Rarebit `task_read` calls took 10.8, 15.7, 63.0, and 64.8 seconds. All eventually succeeded (`metrics.json`, `slowNonWaitCalls`).

Assessment: valid Team and Worker projection is coupled to all-Task Beads hydration. One slow Task backend can erase the useful carrier result.

This confirms the existing hardening blocker in `docs/current/README.md`.

Change:

- Return a typed partial result when Task projection is unavailable.
- Keep valid Team and Worker state in that partial result.
- Never report an empty Task list as success after a Task read failure.
- Add one bounded, read-only retry only if external Beads evidence supports it.
- Avoid `bd show` for unrelated closed Tasks on filtered waits.

### 3. Blocking waits are mostly correct, but timeout and interrupt handling wastes turns

Severity: medium-high.

Observed: the audit contains 256 `team_sync` calls. Of these, 188 requested the maximum 300-second wait.

The calls accumulated 7.07 hours of wait latency across concurrent Sessions. This sum is not wall-clock duration.

Seventy-nine waits returned a successful no-change timeout. Each timeout required another model turn to continue waiting.

Six normal interruptions returned `isError: true` with `Team event wait aborted`. At least four are adjacent to a user correction or progress request. Two are adjacent to custom Session events.

Assessment: positive waiting is correct. The five-minute cap creates periodic wakeups, and normal steering looks like infrastructure failure.

Change:

- Return a typed `interrupted` completion with the last safe cursor.
- Do not classify operator steering as a tool error.
- Make no-change timeout content minimal. Omit repeated projection and shutdown advice.
- Consider a longer host-supported wait or a resumable event subscription.

The 20 one-second Rarebit waits are not a polling loop. They span several hours, and 17 returned queued events.

### 4. `claim` ergonomics caused six identical failed starts

Severity: medium.

Observed: six independent Workers called `task_update` with `claim: true` plus `status` or `append_note`. All six failed with the same error. Each Worker then retried with claim only.

Examples include:

- Rarebit `release-implementer` lines 20 and 25.
- Rarebit `independent-verifier` lines 18 and 20.
- Worker-resource implementer lines 18 and 20.
- Worker-resource verifier lines 14 and 16.

The public schema permits all fields together (`extensions/index.ts:2403-2417`). The semantic implementation rejects every combined claim (`src/utils/tasks.ts:201-207`).

Assessment: this is a predictable interface error, not six independent reasoning failures. The description does not say that claim must be the sole mutation.

Change:

- Encode claim-only arguments as a schema union, or state the restriction in the field description.
- Tell an assigned Worker not to claim its already assigned Task.
- Consider allowing `append_note` with claim, since the start note is evidence rather than assignment state.

### 5. Task history and lifecycle advice are too repetitive

Severity: medium.

Observed: 142 `task_read` calls produced 0.5805 MiB of model-facing text. Rarebit used 107 reads. Worker-resource used 35 reads, but both Teams produced about 0.29 MiB.

The Worker-resource Task accumulated long append-only notes. Its largest read returned 17,034 text bytes. This makes one current-state read replay historical blockers, decisions, handoffs, and superseded completion claims.

Across all calls, model-facing result content was 0.8364 MiB. Full Session tool-result records were 5.8879 MiB because machine details repeat complete Task state.

Rarebit sync content named at least one shutdown candidate in 153 completed calls. It emitted 421 shutdown-candidate phrases. Machine details contained 451 `worker_stop` hints.

Assessment: Task notes are doing both journal and current-state work. Lifecycle advice also conflicts with stable Worker reuse and recurring observers.

Change:

- Add bounded Task note retrieval, such as latest notes or note pagination.
- Let `task_read` omit historical notes by default.
- Keep current Task state separate from append-only progress evidence.
- Recommend `worker_stop` only during explicit cleanup or after an inactivity policy.
- Do not repeat unchanged shutdown advice on each wait result.

## Healthy behavior and priority

The audit found no broad reliability failure:

- All 63 `task_create` calls succeeded.
- All 11 `worker_ensure` calls succeeded.
- All 26 Alerts succeeded and were mostly exceptional coordination.
- All four `worker_stop` calls succeeded.
- Two stale-version updates returned typed refusals, which is correct optimistic concurrency.
- Cursor use was generally event-driven. The long waits were deliberate.

Repair in this order:

1. Expose continuation arguments to the model and scope filtered projections.
2. Isolate Task hydration failures from Team and Worker projection.
3. Make interrupted waits semantic results, not errors.
4. Prevent invalid compound claims before execution.
5. Bound Task-note and lifecycle-advice replay.

## Reproduction and provenance

`metrics.json` is the machine-operable call result. `bd-latency.json` contains the Beads/Dolt timing follow-up. The two analysis scripts regenerate them from an immutable prefix snapshot.

The snapshot was captured at `/tmp/pi-team-audit-snapshot-20260802T052359Z`. It is disposable. Each original Session path, prefix line count, and SHA-256 hash is recorded in `metrics.json`.

A later audit can reconstruct each prefix with `head -n <prefixLines> <originalPath>`. Its hash must match before analysis.

Run:

```sh
python3 docs/journal/artifacts/2026-08-02-pi-team-toolcall-audit/analyze.py \
  /tmp/pi-team-audit-snapshot-20260802T052359Z \
  --output docs/journal/artifacts/2026-08-02-pi-team-toolcall-audit/metrics.json
```

The snapshot contains raw private Task and Session text. Do not commit it. The committed metrics retain counts, hashes, timing, and source line references without copying full Task prose.
