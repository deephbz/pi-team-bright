# Origin-main local-fixes assessment

Date: 2026-08-12
Base: `origin/main` at `53367e412ad0217bfcf4845d92a07bb9ebec6de2`
Stage: hardening

## Question

Do the two defects in the supplied local-fixes handoff exist on the published
rc.13 source, and what repair preserves the Task-first contracts?

## Result

Both defects exist. Three disposable focused probes passed against the bad
behavior in 1.25 seconds. The probe file was removed after execution, and the
source tree returned clean before this assessment was added.

1. A runtime snapshot read waited at least 150 ms while the writer lock was
   held, although the writer publishes through atomic replacement.
2. A burst of runtime-directory activity caused concurrent liveness scans.
3. A recovery carrier published its valid new runtime generation before the
   leader's post-spawn check. The leader then rejected and killed that carrier.

Command:

```text
npx vitest run src/utils/__local_origin_main_problem_probe.test.ts --reporter=verbose
```

Observed result: one file and all three probes passed. This was a defect
characterization, not acceptance evidence for a repair.

## Assessment

### `team_sync` liveness storm

`waitForLivenessHint` starts one asynchronous scan for every unfiltered event
from both watched directories. It has no in-flight guard or coalescing. A scan
calls the Coordination producer check, which reads every current Worker's
runtime evidence. `readRuntimeStatus` then acquires the producer lock. This
contradicts the atomic-publish comment in the writer and turns lock files,
temporary files, and normal runtime replacements into overlapping scans and
lock contention.

The handoff's repair direction is correct. Beads is downstream load in this
failure, not the initiating defect.

### recovery carrier self-rejection

Exact-Session recovery already checks the stale generation before spawn. It
then spawns a replacement and performs a second startup-admission check. A fast
replacement can publish its PID between these steps. The second check cannot
distinguish that authorized child from a competing live process, so it rejects
and compensates by killing the valid new carrier. First-binding retry also
performs its only check after spawn.

The handoff's direction is correct: the leader must check old-generation
absence before spawn, while the child owns the new runtime claim. A complete
repair must also serialize or revalidate concurrent recovery attempts. Merely
using two separate Membership leases around preflight and binding leaves a
TOCTOU window in which two stale plans can spawn and overwrite the carrier
target.

## Repair plan

### Slice A: bounded liveness waiting

1. Make `readRuntimeStatus` a direct snapshot read. Keep the writer lock and
   atomic temporary-file replacement. Return `null` for absent or malformed
   snapshots.
2. Filter watcher hints to runtime `*.json` replacements and the exact
   `team-events.jsonl` journal. Ignore known lock, temporary, cursor, and
   unrelated event files. Treat an unavailable filename as one coalesced hint
   so platform uncertainty cannot lose liveness.
3. Replace fire-and-forget scans with one running scan plus one coalesced
   pending scan. Preserve authority-scan priority when timer and file hints
   overlap.
4. Keep the periodic Task-authority scan and final authoritative recheck.
   Do not change Beads code or observation advancement.
5. Add payload-free trace counters for received, ignored, coalesced, and
   executed hints plus wait duration and outcome.

Focused acceptance:

- a reader completes while the writer lock is held and sees an old or new
  complete JSON snapshot;
- temporary and lock storms cause no producer scans;
- relevant runtime and Team-event replacements wake promptly;
- scan concurrency never exceeds one, and a burst causes at most one queued
  recheck;
- timeout and cancellation complete on schedule under continuous noise;
- existing event-register race, authority cadence, and observation tests pass;
- an eight-Worker runtime-update stress run keeps `team_sync` within its
  configured bound and records no scan fan-out.

### Slice B: recovery ownership and ordering

1. Add a named pure recovery-preflight operation instead of using PID `-1` as
   a synthetic startup claimant. It must validate the exact Membership,
   Session or launch capability, recorded generation, and exact PID absence.
2. Run preflight before spawn for both exact-Session resume and first-binding
   retry.
3. Serialize preflight, carrier spawn, and target persistence under the exact
   Membership mutation boundary, or revalidate the carrier plan before spawn.
   A concurrent stale ensure must reuse or refuse; it must not spawn a second
   carrier.
4. Remove the leader's post-spawn runtime admission. The replacement Pi process
   remains the only owner of startup admission and runtime publication.
5. Preserve exact-target compensation when spawn or persistence fails.

Focused acceptance:

- a fast child runtime claim survives and recovery returns the new carrier;
- a live old generation refuses before spawn and changes no terminal target;
- dead, absent, malformed, and mismatched generation cases keep current
  fail-closed rules;
- first-binding retry follows the same ordering;
- two concurrent recovery calls create at most one carrier;
- persistence failure stops only the candidate and keeps the prior Membership;
- a real Pi/Herdr recovery proves the new PID, exact Session, pane survival,
  and exact stop receipt.

## Delivery gates

Implement the two slices independently and run their focused tests. Then run
independent review against the exact diff. After both slices are stable, run
`npm run typecheck`, the relevant external E2E, public-surface and package
diffs, and the reserved aggregate once. Update the evergreen context and this
result lineage before release work.
