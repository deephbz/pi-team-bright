# rc.6 integration lead handoff

Date: 2026-08-05
Status: active integration; no release action has run

## Owner mandate

Deliver and publish both mandates end to end:

1. Minimize native `bd` CLI calls and hydrated Task-ID scope behind unchanged Pi Team Bright semantics. Prefer one multi-ID call over N calls. Native Beads internal per-ID database behavior is out of scope.
2. Make the new-era Pi Team Bright Task ontology the only schema above the Task-authority adapter. Tool semantics, Worker tools, `team_sync`, delivery machine records/content, TUI, events/outboxes/lifecycle records, and tests use one canonical Task card and public `TaskVersionRef`. Old Beads fields, metadata encoding, raw IDs, and raw revisions exist only inside the Beads adapter.

Delivery exists to provide timely current semantic content and avoid a later `task_read`. It must persist the mutation's canonical post-state, equal the `task_read` card field-for-field, and add zero `bd` calls.

## Epoch recovery completed

The first Team, `beads-call-minimization`, mixed an rc.4 leader with rc.5 Workers. Its Workers could not mutate Tasks. Durable handoffs were preserved, every Task was resolved, all Workers were stopped, and the Team shut down with no unfinished Tasks.

A fresh Herdr Pi coordinator now owns integration:

- agent: `ptb-rc6-coordinator`
- Herdr tab: `w4:t5A`
- pane: `w4:pT0`
- cwd: this package
- launch: exact working-tree `extensions/index.ts`, Pi 0.83.0, `openai-codex/gpt-5.6-sol:high`
- active Team: `canonical-task-integration`

The owner asked this coordinator for progress, then sent `continue then`. Its last visible action was `team_sync` supervision.

## Accepted progress

- Fresh single-version Team created with five Workers and durable assigned Tasks.
- Independent candidate-diff safety audit closed.
- Canonical cutover acceptance design closed, but its permissive raw-version and runtime-legacy clauses were explicitly superseded by the strict lead decision below.
- Safe call-minimization integration Task `canonical-task-integration-0ql` closed.
- Initial canonical implementation Task `canonical-task-integration-rca` closed, but independent verification rejected it.
- Independent verification Task `canonical-task-integration-f5a` is blocked by repair Task `canonical-task-integration-88y`.
- Repair Task `canonical-task-integration-88y` is in progress with `canonical-cutover-implementer`.

Safe performance candidates retained for final proof:

- exact `task_read` uses one multi-ID `bd show` for unique requested IDs, then restores input order and duplicates;
- Worker read must use the direct current semantic path and one authority read, not a legacy receipt plus rehydration;
- `task_link` can skip the outer source read only when no expected public version needs resolution.

Unsafe candidates were removed unless later independently proven:

- event-directed `team_sync` cache that can combine event A with stale silent change B;
- batched update preflight reused across earlier items or external writes;
- create receipt shortcut that weakens post-lock operation-identity validation;
- compact lifecycle list-only guards that can race external assignment.

Native probe evidence is preserved in `docs/journal/2026-08-05-native-beads-multi-id-probe.md` and its JSON artifact. It confirms multi-ID `show` semantics and the small snapshot command shape.

## Strict canonical boundary decision

The following gates are mandatory:

- `TaskDeliveryRecord` stores the exact canonical `TaskCard`, not a duplicate delivery Task type.
- `TaskChangeRef` has canonical Task identity and `TaskVersionRef`; it has no optional `authorityId` or `nativeId` compatibility fields.
- Delivery and owner-transition records contain no raw authority revisions.
- Raw semantic details above the adapter also use canonical cards and public versions.
- Runtime delivery code does not infer goal or context from `description`, `acceptanceCriteria`, `design`, or notes.
- Normal runtime accepts canonical records only and fails closed for unmigrated records.
- If old delivery/outbox state must survive, an explicit stopped-epoch migration rehydrates canonical current cards through the Beads adapter with scoped list plus multi-ID show. It never infers executable meaning from old delivery fields.
- Remove the Worker legacy tool/receipt adapter. Register Worker `task_read`, `task_update`, and `alert_send` directly on current semantic executors and schemas.
- Confine `TaskFile`, raw Beads records, `description`, `acceptanceCriteria`, `design`, notes, provenance, candidate metadata encoding, native commands, and raw revisions to the Beads adapter boundary.
- Remove `Candidate*` facades when they only preserve the retired lifecycle vocabulary.
- A successful current-domain delivery cannot publish placeholder goal or current context.

## Current unresolved work

Repair Task `88y` must remove remaining raw-version, migration, event/ref, Worker-schema, and real delivery-parity failures. The last known candidate tree was still changing and contained a duplicated delivery Task projection plus runtime migration logic; do not accept or release it without the blocked verifier's fresh result.

After `88y` closes:

1. Resume verifier Task `f5a` on the stable tree.
2. Require focused semantic, command-count, delivery parity, migration, no-baseline-advance, graph/version, and forbidden-vocabulary evidence.
3. Fix findings through new assigned repair Tasks; do not let the verifier implement.
4. Update `docs/current/README.md`, `docs/reference.md`, current contract/release docs, and the Structurizr source if the accepted adapter responsibility boundary changes.
5. Only after implementation and focused verification close, prepare the next prerelease, expected to be `0.17.0-rc.6` unless repository evidence selects another version.
6. Bump package/lockfile, implementation epoch constant, README install reference, generated contract artifacts, and release checklist together.
7. Run the broad package/release lane once on the exact final tree, then package verification and privacy gates.
8. Use approved public identity `deephbz` with the GitHub noreply email. Repository privacy protection is enabled. Do not bypass hooks. Run the required privacy scan before publication.
9. Commit, push, tag, use the established GitHub Actions OIDC publish path, verify registry bytes/provenance/dist-tag/GitHub prerelease, and write a durable release receipt.
10. Resolve all Team Tasks, stop Workers with exact evidence, and shut down the Team.

No commit, version bump, tag, push, aggregate release lane, or publication has occurred for this work.
