# RC.6 canonical Task post-state boundary handoff

Date: 2026-08-05
Tasks: `rc6-code-quality-round-gsj`, `rc6-code-quality-round-td2`
Baseline HEAD: `27a532d1c9c9696afe3790c081028aae8af77d76`

## Result

The adapter now projects raw authority envelopes through `projectTaskCard`
([`src/model-tool-contract/beads-task-adapter.ts`](../../src/model-tool-contract/beads-task-adapter.ts)). Mutation receipts carry that exact card through delivery, owner completion, recovery, and model results. Delivery accepts the canonical card on the production path and adds no authority read ([`src/model-tool-contract/beads-authority-adapter.ts`](../../src/model-tool-contract/beads-authority-adapter.ts), [`src/utils/task-delivery.ts`](../../src/utils/task-delivery.ts)). Link publication reuses the post-show envelope metadata.

The semantic facade now exports only canonical TaskCard reads and lists;
mutation authority, constants, resolver, and receipts remain adapter-owned.
Delivery and publication APIs expose TaskCard and no duplicate partial
TaskPublicationInput type. Alerts reject raw task versions with
`upgrade_required` before delivery.

Normal Team events and result projections reject raw versions with
`upgrade_required` ([`src/utils/team-events.ts`](../../src/utils/team-events.ts), [`src/model-tool-contract/result-projection.ts`](../../src/model-tool-contract/result-projection.ts)). The stopped migration now refuses active Memberships, converts bounded legacy delivery/event records, maps `change=design` to `goal`, and has an explicit CLI: `npm run migrate:task-delivery -- <team-name>` ([`src/utils/task-delivery-migration.ts`](../../src/utils/task-delivery-migration.ts), [`src/cli/migrate-task-delivery.ts`](../../src/cli/migrate-task-delivery.ts)). It does not infer Task meaning from compatibility prose.

## Verification

- `npm run typecheck` — passed.
- `npx vitest run src/model-tool-contract/canonical-task-cutover.acceptance.test.ts src/model-tool-contract/beads-task-adapter.test.ts src/model-tool-contract/durable-model-tool-port.test.ts src/model-tool-contract/mutation-call-minimization.test.ts src/utils/alerts.test.ts src/utils/task-delivery.test.ts src/utils/version-delivery-round3.test.ts src/utils/round2-contract.test.ts src/utils/tasks-event-publication.test.ts --pool=forks` — 8 files, 58 tests passed.
- `git diff --check` — passed.
- Working-tree manifest SHA-256: `4f4e0d1cdfde9ce847c2f61e47a5731f0a7bfc136c9b0581808f69592d3d5560`.

Architecture impact: **none**. No component, dependency, data flow, trust
boundary, deployment topology, or Structurizr responsibility changed. No
aggregate, VCS, package, version, or release action ran.
