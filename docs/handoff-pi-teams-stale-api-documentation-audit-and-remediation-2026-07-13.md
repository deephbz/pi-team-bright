# Handoff: PiTeams stale API documentation audit and remediation (2026-07-13)

## Scope and authority

This is a documentation handoff, not an implementation change. The runtime authority is the Pi extension tool registration in `extensions/index.ts`; the canonical operational guide is `skills/teams.md`. `docs/reference.md`, `docs/guide.md`, and portions of `README.md` have drifted and should not be used as the source for new tool calls until reconciled.

The current extension registers 21 tools. `src/utils/tool-surface.test.ts` is the executable guard that asserts every registered tool is documented in the shipped skill.

## Confirmed drift

`docs/reference.md` teaches APIs that are not registered: `team_delete`, `read_config`, `force_kill_teammate`, and `task_get`. The actual replacements are `team_shutdown`, runtime-backed teammate inspection, `process_shutdown_approved`, and `task_read`.

The reference is also incomplete: it omits `spawn_lead_window`, `cleanup_agent_sessions`, `task_read`, and the template operations (`list_predefined_teams`, `list_predefined_agents`, `create_predefined_team`, `save_team_as_template`, and `list_runtime_teams`).

Several documented contracts disagree with runtime behavior:

- `task_create` is documented as accepting status and owner, although ownership and status transition through `task_update`.
- `task_update` omits claim, expected-version, dependency, progress, and pending-problem paths.
- `send_message` documents a `color` parameter that belongs to `broadcast_message`, not direct messages.
- plan rejection is described as moving a task to `in_progress`; runtime retains `planning` and stores the feedback.
- the reference claims a teammate automatically sends a started message to the lead. Runtime injects an initial user prompt/inbox-read instruction instead; it does not create that lead inbox event.

`docs/guide.md` repeats the removed force-kill/delete workflows. Its numeric task-ID examples are also misleading after a Beads cutover, where identifiers are Beads IDs rather than local numeric IDs.

`README.md` understates supported terminal environments by limiting separate-window claims to iTerm2 and WezTerm despite registry support for cmux and Windows. Conversely, its universal title/liveness claim is too broad: Windows Terminal uses synthetic window IDs that cannot support the same kill/liveness guarantees.

`skills/teams.md` is generally aligned with runtime, but its completion-hook wording should not say hooks are only for legacy tasks: `BeadsTaskStore` also invokes the completion hook.

## Recommended remediation order

1. Treat `extensions/index.ts` plus its parameter schemas and return details as the public API contract. Rebuild `docs/reference.md` from that contract instead of patching isolated examples.
2. Update `docs/guide.md` to use only registered names and current lifecycle flows. Use representative Beads IDs where the guide discusses cutover-aware tasks.
3. Correct the completion-hook scope in `skills/teams.md` and preserve it as the concise model-facing guide.
4. Split terminal capability claims by adapter, especially Windows synthetic-window limitations.
5. Add an executable documentation-contract test that rejects unregistered tool names in reference/guide/README and asserts that all registered tools have parameter and lifecycle coverage. The existing skill-surface test is a starting point, not sufficient coverage.

## Validation after remediation

Run `npm test`, then manually verify each documented workflow in a fresh Pi session. For Beads workflows, query the configured absolute `taskWorkspace` rather than assuming the repository root is authoritative. After `team_shutdown`, validate both `bd --directory <taskWorkspace> show <id>` and `bd --directory <taskWorkspace> graph --dot <id>`; `bd graph --all` intentionally excludes closed work.

## Non-goal recorded here

The prompt-export facility was intentionally removed from PiTeams because it is a generic Pi observability concern, not a team-orchestration concern. Package it as a standalone Pi extension with its own install and compatibility contract rather than reintroducing it through the PiTeams tool surface.
