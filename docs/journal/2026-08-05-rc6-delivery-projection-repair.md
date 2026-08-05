# RC.6 delivery projection opaque-version repair

Date: 2026-08-05
Task: `rc6-boundary-repair-r2-72b`

Independent verification found that `projectTaskForAgent` returned an early
clone before validating its version. The function now validates the supplied
Task publication version before every branch and validates an input card's
version before cloning it. Raw authority revisions now fail with
`upgrade_required`; canonical `TaskVersionRef` values pass unchanged.

Focused verification passed:

- `npm run typecheck`
- Vitest: canonical boundary acceptance and Task delivery, 2 files and 19 tests
- `git diff --check`

Architecture impact: **none**. The canonical Structurizr DSL remains unchanged.
This repair only strengthens an internal delivery projection invariant.
