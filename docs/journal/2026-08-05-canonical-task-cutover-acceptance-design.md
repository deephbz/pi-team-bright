# Canonical Task cutover acceptance design

Date: 2026-08-05
Task: `canonical-task-integration-5xu` — Design executable canonical-cutover acceptance
Baseline: `27a532d` (`0.17.0-rc.5` publication); the shared checkout contains concurrent candidate edits.

## Acceptance boundary

The public Task boundary has one canonical card. Its fields are `id`, bounded
`title`, executable `goal` or `goal_state: incomplete`, `status`, optional
`assignee`, bounded `current_context`, and opaque `TaskVersionRef`.

`TaskVersionRef` is the only version that crosses the model, Worker, or Task
change content boundary. It matches `^v_[0-9a-f]{16}$`. A raw authority version
may exist in adapter records, mutation preconditions, delivery identity, QA
details, or payload-free trace records. It must not exist in public Task cards,
model `content`, Worker result content, or `pi-teams.task-change` content.

The canonical card is a publication snapshot at one authority revision. It is
not current authority state, a write authority, a progress signal, or a
replacement for `task_read`.

## Ownership contract

- The neutral Task-domain module owns `TaskCard`, `TaskVersionRef`, card
  schemas, bounded display rules, and card equality. It imports no Beads
  module.
- The Beads adapter owns translation from native records and candidate metadata
  to the neutral card, native command shape, missing-record translation, and
  authority error translation. It is the only layer that knows `TaskFile`, raw
  metadata, `bd`, or Beads-specific fields.
- Task mutation authority owns locked writes, expected-version checks, native
  post-write hydration, operation replay, and publication inputs. It does not
  format model or delivery text.
- Model and Worker ports own authorization and result envelopes. They expose
  canonical cards and `TaskVersionRef`; they do not expose raw authority
  records, raw revisions, relations, descriptions, acceptance criteria, or
  delivery coordinates.
- Task delivery owns recipient binding, deduplication, persistence, and
  presentation. Publication receives the already-built canonical card and does
  not call the Task authority to rebuild it.
- The one-time migration owns conversion of old delivery and outbox records.
  Normal delivery and recovery do not retain a legacy fallback after the
  migration boundary.

## Forbidden vocabulary scan

Run this scan against registered model and Worker schemas/descriptions and
serialized public content. A match is a failure. The scan must not inspect
internal adapter comments or QA raw details as public text.

```sh
rg -n -i \
  '(^|[^[:alnum:]_])(beads|bd|taskfile|tasksnapshot|committedtasksnapshot|dolt|native[ _-]+notes?|acceptance[_ -]?criteria|relations|provenance|deliveryid|recipientmembershipid|recipientsessionfile|authorityid|nativeid)([^[:alnum:]_]|$)' \
  src/model-tool-contract/catalog.ts \
  src/model-tool-contract/result-projection.ts \
  src/model-tool-contract/in-memory-team-port.ts \
  src/model-tool-contract/executors.ts \
  extensions/index.ts
```

The implementation must add an executable test that extracts the registered
public tool schemas and descriptions, serializes only their public fields, and
asserts the same forbidden vocabulary list is absent. It must also assert that
`append_note` has semantic wording and does not name the persistence backend.
The source scan is a review aid; the executable extraction test is the gate.

A second source scan proves the cutover is bounded:

```sh
rg -n 'taskSnapshot|committedTaskSnapshot' src extensions \
  --glob '!**/*.test.ts' --glob '!**/migrate*'
```

After the migration boundary, this command must return no active-runtime
matches. A named migration module may contain the terms only while the
migration release is supported; the next stopped epoch removes that module and
its compatibility types.

## Focused executable tests

Add one focused acceptance file, for example
`src/model-tool-contract/canonical-task-cutover.acceptance.test.ts`. Keep each
failure tied to one invariant.

### 1. Card and version boundary

Use a fake authority record with a raw revision such as
`beads_authority_version_7` and candidate metadata. Assert all of the
following:

- adapter output is a complete canonical card;
- the version is a `TaskVersionRef` and equals
  `taskVersionRef("beads_authority_version_7")`;
- the card has no `TaskFile` fields (`description`, `acceptanceCriteria`,
  `design`, `relations`, `provenance`, or raw authority identifiers);
- an oversized goal produces `goal_state: incomplete` and a warning, never
  executable goal prose;
- `task_read`, `task_create`, `task_update`, and `team_sync` use the same card
  field set and version rule;
- schema validation rejects a raw version such as `task_v7` and accepts only
  the opaque `v_` form.

This test must import the neutral card contract and the adapter separately. It
must fail if the public card contract imports `src/utils/beads`.

### 2. Delivery parity at mutation publication

Use a deterministic `BdRunner` or authority seam with a command trace. Create
or update one assigned Task through the real mutation path. Capture the
canonical post-state card returned by the mutation authority. Inspect the
persisted delivery record and the parsed `pi-teams.task-change` content.

Assert:

- the delivery card equals the mutation post-state card field-for-field,
  including the same opaque version, title, goal or incomplete state, status,
  assignee, and current context;
- a direct `task_read` projection of that same authority revision equals the
  delivery card;
- delivery content contains only the card coordinates and no raw authority or
  delivery fields;
- publication performs zero additional `bd` commands after the mutation
  authority supplies the post-state card;
- create reuses the exact post-create authority record from its receipt;
- update and assignment publication reuse the supplied canonical card;
- owner-transition recovery uses its persisted canonical card and does not
  issue one authority read per recipient. A prepared intent may perform one
  bounded authority-evidence read per distinct Task only when commit evidence
  is missing.

Count commands by the existing payload-free `recordBdCall` trace and also spy
on the authority seam. Do not assert that the mutation itself has no reads:
locked precondition reads and post-write hydration remain authority duties.
The unique assertion is that delivery adds no read.

### 3. Existing authority translation

Run the adapter against native-shaped records that contain compatibility
`description`, `acceptance_criteria`, relation data, raw metadata, and native
revision fields. Assert that candidate metadata, not compatibility prose,
provides `goal` and `current_context`. Assert missing or malformed candidate
metadata returns the typed contract gap and does not invent executable prose.

Assert native missing-ID behavior remains ordered and exact: one requested
batch yields one result position per unique ID, and duplicate model input IDs
are restored without a second native show. Assert native error kinds map to
backend-neutral public reasons. No public result or description may contain the
native command, backend name, or raw record shape.

### 4. Bounded legacy migration

Choose the stopped-epoch migration route. Before starting delivery, stop the
old implementation epoch and run one atomic migration over:

- recipient delivery files;
- enqueue-recovery records; and
- owner-transition outbox records.

The migration acceptance fixture must include one legacy record with only
`taskSnapshot` and one owner-transition record with only
`committedTaskSnapshot`. The migration must:

- derive a canonical card locally from each complete legacy snapshot;
- write the canonical projection and retain only the internal authority
  revision needed for delivery identity;
- preserve recipient, membership, session, change kind, and replay identity;
- use atomic replacement and be idempotent;
- leave no legacy snapshot key in a successfully migrated record;
- publish the same card as a newly written record; and
- produce a bounded migration receipt with counts for scanned, converted,
  unresolved, and failed records.

Add a negative fixture with a legacy record that cannot form a safe card. The
migration must fail closed, keep the original record intact, and report the
record path plus a typed blocker. It must not publish placeholder goal prose.

The stopped-epoch test must start the post-cutover delivery against migrated
files and assert that it never invokes the legacy conversion path. A final
filesystem scan must find zero `taskSnapshot` or `committedTaskSnapshot` keys
in active delivery, recovery, and outbox records. A second migration run must
be a no-op. The compatibility adapter and its types are removed after this
single release boundary; retaining both schemas without a removal condition is
not accepted.

## Acceptance commands and evidence

Another Worker can execute the following on the reconciled, single-version
checkout:

```sh
npm run typecheck
npx vitest run \
  src/model-tool-contract/canonical-task-cutover.acceptance.test.ts \
  src/model-tool-contract/beads-task-adapter.test.ts \
  src/model-tool-contract/result-projection.test.ts \
  src/model-tool-contract/task-update-version-ref.test.ts \
  src/utils/task-delivery.test.ts \
  src/utils/owner-transition-outbox.contract.test.ts
npm run test:lanes
```

For the final boundary, also run:

```sh
git diff --check
npm run test:full
npm run verify:package
```

The handoff must include the exact commit, test counts, command-trace counts,
migration receipt, and scan output. It must state whether architecture impact
is `none`: this cutover changes the Task projection and persistence epoch but
not the depicted component topology or dependency direction.

## Non-acceptance conditions

Do not accept a design that lets delivery call `task_read` after a mutation,
uses raw `TaskFile` as a model or Worker card, exposes raw authority versions,
infers goal from compatibility fields, keeps an unbounded dual-schema runtime,
or treats a delivery snapshot as current authority state. Do not accept a
successful test that proves only serialized shape; parity and command-trace
evidence are required.
