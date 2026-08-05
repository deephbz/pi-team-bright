# RC.6 exact Task/Beads boundary repair handoff

Date: 2026-08-05
Status: implementation and focused verification closed; release preparation pending

## Result

The repair preserved HEAD `27a532d1c9c9696afe3790c081028aae8af77d76`.
No remaining gaps were reported for this repair scope. Native Beads records,
metadata, revisions, CRUD fields, `RawBead`, and `TaskFile` remain behind the
Beads adapter boundary. The production Task surface uses canonical `TaskCard`
and opaque `TaskVersionRef`; `tasks.ts` is semantic-only. Unreachable legacy
extension tools, the legacy Worker bridge, and legacy prompt wording were
removed. Stopped-epoch delivery migration remains explicit and adapter-backed.

## Verification evidence

The closed implementation and verifier evidence recorded these focused checks:

- `npm run typecheck` passed.
- The model-contract lane passed 9 files and 68 tests.
- The prior focused lane passed 12 files and 83 tests.
- Canonical acceptance plus call minimization passed 2 files and 8 tests.
- The final focused repair checks passed canonical acceptance (8 tests), the
  model/call-minimization/durable/delivery lane (33 tests), tool-surface (9
  tests), and the Worker one-read check (1 test).
- Delivery parity recorded `bdCallCount: 0`.
- `npm run docs:model-tools` and `git diff --check` passed.

The only npm warning was non-failing configuration noise:
`npm warn Unknown user config "min-release-age".`

## Handoff boundary

Architecture impact is **none**: the repair changes internal Task/Beads
responsibility and source ownership, not a depicted component, dependency,
trust boundary, deployment topology, or Structurizr responsibility. The DSL
was not changed.

The exact pre-handoff working-tree identity is:

- HEAD: `27a532d1c9c9696afe3790c081028aae8af77d76`
- index tree: `bd8e83dc6d50810dd8a75c436777dfb8f2ea4741`
- working-tree manifest SHA-256: `47da77d1a0b5094733517dddb77f478458f0e4d03edcc0527f8e3e1f993e14a9`

No aggregate suite, package/release action, version bump, commit, tag, push,
or publication ran. The next Team must prepare the release and run one
aggregate lane on the exact stable tree before any publication action.
