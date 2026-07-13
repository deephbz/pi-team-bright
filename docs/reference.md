# PiTeams tool reference

PiTeams registers exactly 21 Pi tools. The names and schemas below are the
public tool surface; examples are Pi tool calls, not shell commands.

## Team lifecycle

### `team_create`

Creates a team and registers the current session as its lead.

Required: `team_name`.

Optional: `description`, `default_model`, and `separate_windows` (default
`false`). `default_model` is inherited by spawned teammates when supplied;
omit it to keep Pi's configured default. `separate_windows` requests OS
windows instead of panes and is rejected when the selected adapter does not
support windows.

```js
team_create({ team_name: "audit", description: "Security review" })
```

Creating a team does not itself spawn a teammate or require a terminal adapter.
A terminal adapter is required by the spawn tools.

### `spawn_teammate`

Starts a teammate in a pane or OS window and adds it to the roster.

Required: `team_name`, `name`, `prompt`, `cwd`.

Optional: `model`, `thinking` (`off`, `minimal`, `low`, `medium`, `high`, or
`xhigh`), `plan_mode_required` (default `false`), and `separate_window`
(default `false`). Omit `model` unless an explicit override is requested.
`cwd` must be absolute. A discovered agent definition with the same name can
supply a Pi tool allowlist to the launched process. Spawning a name already in
the roster stops and replaces that teammate.

The initial `prompt` is written to the teammate's inbox. The teammate process
also receives an injected instruction to call `read_inbox`; PiTeams does not
make that tool call on its behalf. The spawn operation does not create a
"started" message in the lead's inbox.

### `spawn_lead_window`

Opens the existing lead session in a separate OS window.

Required: `team_name`. Optional: `cwd` (defaults to the current working
directory). The selected adapter must support OS windows.

### `check_teammate`

Inspects one roster member.

Required: `team_name` and `agent_name`.

The result includes `alive`, `unreadCount`, `health`, `agentLoopReady`,
`hasRecentHeartbeat`, `startupStalled`, and runtime telemetry. Health is
terminal/process and inbox telemetry, not task status. The normal labels are
`dead`, `stalled`, `healthy`, `idle`, and `starting`. A dead member's runtime
status file is removed.

### `process_shutdown_approved`

Shuts down one teammate, removes its runtime status, and removes it from the
roster.

Required: `team_name` and `agent_name`. The lead cannot be removed with this
tool. PiTeams attempts both the tracked process and the adapter pane/window.

### `team_shutdown`

Stops all teammates and performs orphaned Pi-session cleanup.

Required: `team_name`.

For a legacy team it removes the team and local task directories. For a
Beads-cutover team it retains the team configuration, Beads authority, and
legacy task files as migration evidence; task truth is not deleted. The
response reports whether task authority was retained and how many old agent
session folders were cleaned. It does not replace post-shutdown inspection of
the Beads workspace.

### `cleanup_agent_sessions`

Removes orphaned folders under `~/.pi/agent/teams/`.

Optional: `max_age_hours` (default `24`). The tool returns the number removed.
`team_shutdown` invokes the same cleanup with a one-hour threshold.

## Communication

### `send_message`

Writes one transient inbox message.

Required: `team_name`, `recipient`, `content`, and `summary`. There is no
`color` parameter on direct messages.

### `broadcast_message`

Sends one transient message to every team member except the sender.

Required: `team_name`, `content`, and `summary`. Optional: `color`.

### `read_inbox`

Reads an agent inbox.

Required: `team_name`. Optional: `agent_name` and `unread_only` (default
`true`). Omitting `agent_name` reads the current agent's inbox. Reading an
inbox is communication-state inspection; it does not claim or update a task.
For a teammate reading its own inbox, PiTeams records that the agent loop is
ready and updates heartbeat telemetry.

Teammates poll their own inbox while idle about every 30 seconds. The lead
also polls while idle after creating or reconnecting to a team.

## Tasks

### `task_create`

Creates a task in the team's configured task backend.

Required: `team_name`, `subject`, and `description`.

Optional: `active_form`, `metadata`, and `idempotency_key`. New tasks start as
`pending`; ownership and status are changed later with `task_update`. The
returned `id` is the backend task ID.

```js
task_create({
  team_name: "audit",
  subject: "Review authentication",
  description: "Check the authentication handlers for unsafe input."
})
```

### `task_read`

Reads one complete task record.

Required: `team_name` and `task_id`. The record can include its backend ID,
description, plan and feedback, owner, dependency fields, metadata, and a
backend version token in `version`. Use the exact ID returned by `task_create`
or `task_list`. For a subsequent Beads mutation, pass the returned `version`
value as `expected_version`.

### `task_list`

Lists the team's current non-deleted tasks.

Required: `team_name`. IDs are not universally numeric: legacy tasks normally
use local numeric IDs, while Beads-cutover tasks use Beads IDs.

### `task_update`

Performs one atomic backend mutation.

Required: `team_name` and `task_id`.

At most one of these mutation paths may be used per call:

- `status`: `pending`, `planning`, `in_progress`, `completed`, or `deleted`;
- `owner`: an assignment name, or an empty string to clear it;
- `claim`: atomically claim for the current agent where supported;
- `blocks` or `blocked_by`: dependency IDs;
- `progress`: append a communicated progress entry;
- `pending_problem`: append an unresolved-problem entry.

`expected_version` is an optimistic concurrency token from `task_read` or
`task_list`: copy the returned task's `version` field into this parameter.
Re-read the task and copy the new `version` between separate mutations.
`blocked` is a derived
read state, not a writable status. On Beads, `blocks` is rejected because it
would mutate another task without a second version token; add `blocked_by` to
the target task instead.

Beads-cutover non-claim writes require `expected_version`. Beads 1.1.0 has no
true CLI compare-and-swap, so the token is a serialized preflight and another
writer can still race after the check. A failed Beads command, timeout,
malformed response, scope failure, or conflict fails the tool; PiTeams never
falls back to legacy files.

Completion hooks run when a task is completed. See [Hooks](#completion-hook)
for backend-specific transition details. In the legacy backend, `deleted`
removes the task file. In Beads, `deleted` is a closed, soft-deleted record so
history remains available.

### `task_submit_plan`

Submits a non-empty plan and sets the task to `planning`.

Required: `team_name`, `task_id`, and `plan`. Optional:
`expected_version`. A Beads-cutover task requires the version token.

### `task_evaluate_plan`

Evaluates a submitted plan.

Required: `team_name`, `task_id`, and `action` (`approve` or `reject`).
Optional: `feedback` and `expected_version`; rejection requires non-empty
feedback, and Beads requires the version token. Approval sets
`in_progress`. Rejection keeps the task in `planning` and stores the feedback;
it does not move the task to `in_progress`.

## Templates and runtime teams

### `list_predefined_teams`

Takes no parameters. Lists templates discovered from global and project
`teams.yaml` files and reports whether referenced agent definitions exist.
Global definitions are read from `~/.pi/teams.yaml`, with the historical
`~/.pi/agent/teams.yaml` location also supported; project definitions are in
`.pi/teams.yaml`.

### `list_predefined_agents`

Takes no parameters. Lists discovered agent definitions and their `name`,
`description`, `tools`, `model`, and `thinking` fields. Global definitions
come from `~/.pi/agent/agents/`; project definitions come from `.pi/agents/`.

### `create_predefined_team`

Creates a team from a discovered template and attempts to spawn all of its
agents, returning per-agent `spawned`, `skipped`, or `error` results.

Required: `team_name`, `predefined_team`, and `cwd`.

Optional: `default_model` and `separate_windows` (default `false`). Agent
settings and tool allowlists from each definition are used when launching.

### `save_team_as_template`

Saves a runtime team with at least one spawned teammate as reusable agent
files plus a `teams.yaml` entry.

Required: `team_name` and `template_name`. Optional: `description` and `scope`
(`user` or `project`, default `user`). User scope writes under `~/.pi`; project
scope writes under the current project.

### `list_runtime_teams`

Takes no parameters. Lists runtime team configurations under `~/.pi/teams/`
that can be saved as templates. It reports name, description, member count,
and creation time; it does not create or delete teams.

## Completion hook

The supported hook is `.pi/team-hooks/task_completed.sh`, resolved relative to
the current Pi process working directory. When a completion write invokes it,
the task record is passed as a JSON string in the first argument and `PI_TEAM`
is set to the team name.

Both the legacy task store and `BeadsTaskStore` invoke the hook. Legacy runs it
when `task_update` writes `completed`; Beads runs it when a task transitions to
closed through completion. Hook failure is logged and does not undo the task
mutation. A hook is not a transactional quality gate.

## Task authority and Beads cutover

A team without `taskBackend: "beads"` uses the legacy JSON task store under
`~/.pi/tasks/<team>/`. Legacy IDs are local numeric strings. Migration is
explicit:

```sh
npm run migrate:tasks -- <team-name> <absolute-beads-workspace> [report-path]
```

The workspace must be absolute and contain an initialized Beads repository.
The migration inventories and hashes legacy files, imports or reconciles by
`pi_teams_legacy_id`, maps statuses, owners, plans, dependencies and metadata,
reconciles before and after values, and only then records the cutover. An
interrupted migration can be rerun safely. Pre-cutover drift blocks authority
change until reviewed; an operator override is explicit and persisted.

After cutover the team config records `taskBackend: "beads"`, the absolute
`taskWorkspace`, and cutover evidence. Beads is the sole writable authority.
Changed or newly created legacy files are reported as orphaned old-client
writes and are never imported automatically. Mixed legacy/Beads writers are
not a supported steady state. Beads IDs remain the task IDs; do not translate
them back to local numbers.

Beads mapping is explicit: subject and description become title and
description; owner becomes assignee; `pending` and `planning` are open with a
phase marker; `in_progress` maps directly; `completed` closes the issue;
dependencies use `blocks` links; plans, progress, and problems use namespaced
metadata/comments. PiTeams continues to own membership, panes, processes, and
transient inboxes.

After `team_shutdown` on a Beads-cutover team, use the retained absolute
`taskWorkspace` from the preserved team config:

```sh
bd --directory <taskWorkspace> --json list --label pi-teams:<team-name> --all --no-pager --limit 0
bd --directory <taskWorkspace> show <beads-id> --long --include-comments --include-dependents
bd --directory <taskWorkspace> graph --dot <beads-id> > task.dot
bd --directory <taskWorkspace> graph --html <beads-id> > task.html
```

Include `--all` when listing closed history. `bd graph --all` is an open-work
view; visualize a specific ID when closed dependencies must appear.

## Terminal adapters and limitations

The registry selects the first detected adapter in this order: `tmux`,
`zellij`, `cmux`, `iTerm2`, `WezTerm`, then `Windows`. A missing adapter makes
spawning unavailable. Pane support is available through all six adapters.
Separate OS windows are supported by `cmux`, iTerm2, WezTerm, and Windows
Terminal; `tmux` and Zellij support panes only.

- **tmux** requires `TMUX` and supports pane split/kill/liveness, but never OS
  windows.
- **Zellij** requires `ZELLIJ` outside tmux. It uses `--close-on-exit`, so
  explicit pane kill is a no-op and its synthetic liveness result is
  best-effort; health can be advisory.
- **cmux** is selected by `CMUX_SOCKET_PATH` or `CMUX_WORKSPACE_ID` outside
  tmux/Zellij. It manages surfaces and can create/close windows through the
  `cmux` CLI.
- **iTerm2** requires macOS iTerm2 (`TERM_PROGRAM=iTerm.app`) outside
  tmux/Zellij. Pane and window operations use AppleScript.
- **WezTerm** requires `WEZTERM_PANE` and a working `wezterm` CLI outside
  tmux/Zellij. It supports panes and separate windows; window shutdown is
  implemented by killing the window's panes.
- **Windows Terminal** is selected on Windows outside tmux, Zellij, and
  WezTerm. It requires `wt` at spawn time and PowerShell for commands. Its
  pane/window IDs are synthetic: the adapter has no direct pane/window kill or
  reliable liveness query, and tab titles are limited. Process shutdown may
  still use the tracked teammate PID, but terminal cleanup and
  `check_teammate` liveness are not equivalent to tmux, cmux, iTerm2, or
  WezTerm.

The `separate_window` and `separate_windows` flags therefore express a request,
not a portable guarantee. PiTeams rejects the request when the selected
adapter reports no window capability.
