---
name: pi-teams
description: Operate PiTeams agent orchestration tools for creating teams, spawning teammates, coordinating tasks, and managing teammate lifecycle.
---

# PiTeams

PiTeams is an orchestration extension for Pi. It owns team membership,
terminal panes/windows, inbox messages, runtime health, and the task-tool
workflow. It does not provide slash commands; every operation below is a Pi
tool. The extension registers exactly 21 tools.

## Normal workflow

1. Call `team_create`.
2. Call `spawn_teammate` for each specialist, or use
   `create_predefined_team` for a saved template.
3. Use `task_create`, `task_update`, `task_list`, and `task_read` for work.
4. Use `send_message`, `broadcast_message`, and `read_inbox` for transient
   coordination.
5. Use `check_teammate` while work is running, then
   `process_shutdown_approved` for one teammate or `team_shutdown` for the
   whole team.

When a teammate is launched, PiTeams sends its initial prompt to its inbox and
injects a prompt telling it to call `read_inbox`; it is not an automatic tool
call. Idle teammates poll their own inbox about every 30 seconds. The lead
also polls while idle. A teammate's `check_teammate` health is derived from
terminal liveness, inbox state, startup timing, and runtime heartbeat; it is
not task status.

## Team and teammate tools

### `team_create`

Required: `team_name`.

Optional: `description`, `default_model`, and `separate_windows` (default
`false`). It creates the team and registers the current session as the lead.
`separate_windows` asks the terminal adapter to use OS windows instead of
panes when supported. Omit `default_model` unless the user explicitly requests
an override; omission preserves Pi's configured default.

### `spawn_teammate`

Required: `team_name`, `name`, `prompt`, and `cwd`.

Optional: `model`, `thinking` (`off`, `minimal`, `low`, `medium`, `high`, or
`xhigh`), `plan_mode_required` (default `false`), and `separate_window`
(default `false`). Existing teammates with the same name are stopped and
replaced. The tool rejects missing teams, missing terminal adapters, and
unsupported window mode. Omit `model` unless the user explicitly requests an
override. When `name` matches a discovered agent definition, its `tools`
allowlist is passed to Pi's `--tools` launch option.

### `spawn_lead_window`

Required: `team_name`. Optional: `cwd`. It opens the lead in a separate OS
window and uses the team's default model when one is configured.

### `check_teammate`

Required: `team_name` and `agent_name`. The result includes `alive`,
`unreadCount`, `health` (`dead`, `stalled`, `healthy`, `idle`, or `starting`),
`agentLoopReady`, `hasRecentHeartbeat`, `startupStalled`, and raw `runtime`
telemetry. Dead runtime status files are cleaned up.

### `process_shutdown_approved`

Required: `team_name` and `agent_name`. It kills that teammate's process or
pane/window, removes runtime status, and removes the teammate from the team
roster. The lead is not removed by this tool.

### `team_shutdown`

Required: `team_name`. It stops all teammates and performs the normal orphaned
Pi-session cleanup. For a legacy task backend it removes the team and local
task directories as before. For a Beads-cutover team it retains the team
configuration, Beads authority, and legacy task files as migration evidence;
task truth is never deleted by shutdown.

### `cleanup_agent_sessions`

Optional: `max_age_hours` (default `24`). It removes orphaned folders under
`~/.pi/agent/teams/` older than that age and returns the count removed.

## Communication tools

### `send_message`

Required: `team_name`, `recipient`, `content`, and `summary`. It appends one
message to the recipient's transient inbox. There is no `color` field.

### `broadcast_message`

Required: `team_name`, `content`, and `summary`. Optional: `color`. It sends to
all team members except the sender.

### `read_inbox`

Required: `team_name`. Optional: `agent_name` and `unread_only` (default
`true`). Without `agent_name`, the current agent's inbox is read. Reading a
teammate's inbox is an inspection operation; messages remain PiTeams
communication state, not task state.

## Task tools

### `task_create`

Required: `team_name`, `subject`, and `description`. Optional: `active_form`,
`metadata`, and `idempotency_key`. It returns the backend task ID.

### `task_read`

Required: `team_name` and `task_id`. It returns the full task record, including
its backend ID, description, plan fields, owner, dependency fields, metadata,
and a backend version token in the returned `version` field when available.
Pass that exact `version` value as `expected_version` on the next Beads
mutation. `task_read` is the shipped name;
there is no `task_get`.

### `task_list`

Required: `team_name`. It returns the team's current non-deleted tasks. IDs
are not assumed to be numeric: after Beads cutover they are Beads IDs.

### `task_update`

Required: `team_name` and `task_id`. Optional fields are:

- `status`: `pending`, `planning`, `in_progress`, `completed`, or `deleted`;
- `owner`: assignment name, or an empty string to clear it;
- `claim`: atomically claim for the current agent where the backend supports it;
- `expected_version`: optimistic concurrency token;
- `blocks` and `blocked_by`: dependency IDs;
- `progress`: append a communicated progress entry;
- `pending_problem`: append an unresolved-problem entry.

`blocked` is a derived/read state, not a writable status. Each `task_update`
call accepts one backend mutation; split status, dependency, and progress
changes into separate calls and re-read `expected_version` between them.
Here, “re-read `expected_version`” means call `task_read`/`task_list` again and
copy the returned task `version` into the next call's `expected_version`.
Beads-cutover non-claim writes require `expected_version`; Beads 1.1.0 has no
true CLI CAS, so the token is a serialized preflight and an external writer
can still race after the check. `completed` invokes the configured
`.pi/team-hooks/task_completed.sh` hook for both backends: legacy runs it on a
completed write, while Beads runs it when the task transitions to closed.
Hook failures are logged and do not undo the task mutation. `deleted` is a
real file deletion only in the legacy backend; Beads stores a closed,
soft-deleted record so history is retained.

### `task_submit_plan`

Required: `team_name`, `task_id`, and non-empty `plan`. Optional:
`expected_version`. It stores the plan and sets status to `planning`; a
Beads-cutover team requires the version token.

### `task_evaluate_plan`

Required: `team_name`, `task_id`, and `action` (`approve` or `reject`).
Optional: `feedback`, which is required for rejection, and `expected_version`.
Approval sets `in_progress`; rejection keeps `planning` and stores the
feedback. A Beads-cutover team requires the version token.

## Predefined/template tools

### `list_predefined_teams`

No parameters. Lists team templates discovered from global/project
`teams.yaml` files and reports whether each referenced agent definition exists.

### `list_predefined_agents`

No parameters. Lists discovered agent definitions and their `name`,
`description`, `tools`, `model`, and `thinking` fields.

### `create_predefined_team`

Required: `team_name`, `predefined_team`, and `cwd`. Optional:
`default_model` and `separate_windows` (default `false`). It creates the team
and attempts to spawn every agent in the template, returning per-agent
`spawned`, `skipped`, or `error` results. Omit `default_model` unless the user
explicitly requests an override. Each definition's `tools` allowlist is passed
to Pi's `--tools` launch option.

### `save_team_as_template`

Required: `team_name` and `template_name`. Optional: `description` and `scope`
(`user` or `project`, default `user`). It writes agent definition files and a
`teams.yaml` template, and requires at least one spawned teammate.

### `list_runtime_teams`

No parameters. Lists runtime team configurations under `~/.pi/teams/` that can
be saved as templates, including name, description, member count, and creation
time. It does not create or delete teams.

## Task authority and migration

Teams without `taskBackend: "beads"` use the historical per-task JSON files
under `~/.pi/tasks/<team>/`; this is the legacy compatibility store. A migrated
team records `taskBackend: "beads"`, an absolute `taskWorkspace`, and a
cutover record in its team config. From that point Beads is the sole writable
task authority: if `bd` is unavailable, malformed, times out, rejects a scope,
or reports a conflict, the tool fails with an actionable error and never
writes the legacy files.

Run the migration helper with:

```sh
npm run migrate:tasks -- <team-name> <absolute-beads-workspace> [report-path]
```

The helper inventories numeric legacy task files into an immutable, hashed
inventory; imports or reconciles by `pi_teams_legacy_id`; maps IDs, statuses,
owners, plans, dependencies, progress metadata, and closure; reconciles before
and after values; then records prepared/active cutover events and flips the
team config only after reconciliation succeeds. Re-running an interrupted
migration is idempotent and serialized per team/workspace with a durable lock.
Pre-cutover drift in legacy files blocks authority change until a persisted,
inventory-bound operator override is reviewed. After cutover, changed or newly created legacy files
are reported as orphaned old-client writes and are never imported
automatically. Mixed old/new task writers are not supported steady state.

Beads mapping is intentionally explicit: `subject`/`description` map to title
and description; owner maps to `assignee`; `pending`/`planning` map to Beads
`open` with a phase marker; `in_progress` maps directly; `completed` maps to
closed; dependencies use Beads `blocks` links; plans and progress use
namespaced metadata/comments; Beads IDs remain task IDs. PiTeams still owns
membership, panes, process lifecycle, and transient inboxes.

### Post-shutdown Beads inspection

After a Beads-cutover `team_shutdown`, use the retained absolute
`taskWorkspace` from the preserved team config as the query root. Include
`--all` to retain closed task history:

```sh
bd --directory <taskWorkspace> --json list --label pi-teams:<team-name> --all --no-pager --limit 0
bd --directory <taskWorkspace> show <beads-id> --long --include-comments --include-dependents
bd --directory <taskWorkspace> graph --dot <beads-id> > task.dot
bd --directory <taskWorkspace> graph --html <beads-id> > task.html
```

`bd graph --all` is an open-work view, so visualize a specific task when its
closed dependencies must appear. The Beads workspace is the task authority;
the retained PiTeams config provides the workspace and cutover provenance.

## Nonexistent APIs

Do not call or teach `team_delete`, `read_config`, `force_kill_teammate`, or
`task_get`. They are not registered tools. Configuration is inspected through
the runtime behavior above, individual teammate shutdown uses
`process_shutdown_approved`, whole-team cleanup uses `team_shutdown`, and
individual task reads use `task_read`.
