# RC.6 lead continuation handoff

Date: 2026-08-05
Stage: hardening toward sharing
Status: final narrow quality repair is assigned; release remains blocked until its Team is reconciled and verified

## Owner intent still in force

Deliver and publish the next Pi Team Bright prerelease end to end. Keep Workers on the agreed plan, escalate real blockers, use focused checks during implementation, and run the broad release lane once on the exact final tree. The owner also asked for a status and pending-task update. They recommended the Million Eyes iterative code-quality playbook for post-verification review; the current narrow repair came from that review.

## Preserved tree and completed work

- Branch baseline HEAD remains `27a532d1c9c9696afe3790c081028aae8af77d76` (`0.17.0-rc.5`).
- The RC.6 candidate is still uncommitted. No aggregate release lane, version bump, commit, tag, push, or publication has run.
- Exact multi-ID `task_read`, direct Worker one-read behavior, no-version `task_link` outer-read removal, and zero-added-call delivery remain required.
- Unsafe sync caching, update batch preflight, create shortcut, and compact lifecycle guards remain removed.
- The old Candidate-named production surface, dead legacy extension tools, legacy Worker bridge, and dead `team-sync-actions` module were removed.
- `tasks.ts` now exposes only canonical `TaskCard` reads/lists.
- Versioned `task_link` now resolves one public `TaskVersionRef` to raw CAS inside the adapter; no-version behavior retains no outer read.
- Task delivery no longer constructs `BeadsTaskStore` directly. Team status also uses the adapter diagnostic seam.
- Normal Team-event and model-result paths now reject raw versions with `upgrade_required`.
- A stopped-epoch migration CLI was added as `npm run migrate:task-delivery -- <team-name>`.
- The latest known focused typecheck passed. Earlier focused repair lanes passed, but they did not catch all interface defects and are not a release gate.

## Current narrow repair

A fresh exact-extension coordinator named `ptb-rc6-quality-repair` started Team `rc6-final-quality-repair`. It was assigned one implementer and one independent verifier for two evidence-backed defects:

1. The stopped migration treated every journal record as a Task event. Worker/Alert events could fail migration. It also replaced historical raw Task-event revisions with the current Task-card version, which destroys historical revision identity.
2. `task-delivery.ts` still exposed `unknown` overloads and reconstructed Task cards from partial coordinates/metadata. Normal delivery must accept and validate the exact imported `TaskCard`; coordinates may remain only where a tombstone or prepared intent needs them and must never become a card.

The repair contract requires:

- mixed Task/Worker/Alert event preflight;
- unchanged Worker events;
- deterministic public refs derived from each exact stored historical revision;
- Alert task-ref migration;
- `design` to `goal` conversion and legacy `authorityId` removal;
- full validation before writes and active-Team refusal;
- exact `TaskCard` delivery APIs with no partial fallback;
- owner-transition prepare using an adapter-projected raw envelope so prior-operation delivery has a real card;
- focused migration, delivery, outbox, canonical-boundary, and call-count proof.

The last observed coordinator state was `idle` after its first turn. Its exact outcome, Task states, Worker states, and Team shutdown state were not yet read. Treat them as unknown. Resume through Herdr by reading the recognized agent, then use the exact coordinator Session’s Team tools. Do not create duplicate Tasks or accept prose as Task state.

## Immediate continuation

1. Read `ptb-rc6-quality-repair` recent unwrapped output and reconcile its exact Team with `team_sync`/`task_read` as needed.
2. If implementation or verification is incomplete, resume the same Team. Record any real blocker. Otherwise stop Workers and shut down with zero unfinished Tasks.
3. Perform one lead interface review of the two repaired invariants. Do not repeat broad tests.
4. Give the owner a concise status update: completed canonical/call-minimization work, current repair result, and remaining release steps.
5. After the repair passes, start a fresh release-prep Team with one prep Worker and one independent aggregate verifier.
6. Prepare expected `0.17.0-rc.6`: package/lock/constants, README and generated HTML, current/release docs, and a durable receipt.
7. Run the broad package/release lane once on the exact stable tree, then stop that Team before VCS or publication.
8. Apply public identity/privacy rules, run the full history privacy scan, commit/push normally, tag `v0.17.0-rc.6`, publish through GitHub Actions npm OIDC under `next`, and verify Git/npm/GitHub byte, integrity, provenance, tag, and source-commit evidence.

Architecture impact must be classified again after the final repair. Prior repairs judged it `none`; update current docs and canonical Structurizr together only if a depicted responsibility, dependency, flow, boundary, or topology changed.
