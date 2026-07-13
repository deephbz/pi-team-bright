# Note to the active PiTeams maintainer (2026-07-13)

This handoff is intentional. Please keep and review `docs/handoff-pi-teams-stale-api-documentation-audit-and-remediation-2026-07-13.md`; it records the stale API-documentation findings, the runtime sources of truth, and a proposed remediation order.

I intentionally removed the newly added prompt-export feature from the PiTeams extension because it is generic Pi prompt observability, not team orchestration. Specifically, I removed the `export_system_prompt` registration from `extensions/index.ts`, removed its PiTeams skill text, reset the registered-tool contract to 21 tools, and deleted its PiTeams-local utility, tests, and documentation. Do not restore that feature in PiTeams; package it as a standalone Pi extension with its own install and compatibility contract.

I retained the unrelated post-shutdown Beads inspection documentation and its lifecycle regression test in `skills/teams.md` and `src/utils/tool-surface.test.ts`. Those changes validate that a Beads-backed task remains queryable and graphable after `team_shutdown`.

At handoff time, the only intentional uncommitted changes from this work are the post-shutdown Beads documentation/test, the two handoff documents, and the removal of the prompt-export integration. Please review alongside any concurrent work before committing.
