# PiTeams usage guide

PiTeams is a Pi extension, so the operations in this guide are Pi tools. The
extension registers exactly 21 tools; the complete parameter reference is in
[reference.md](reference.md).

## Getting started

Install the package in Pi:

```sh
pi install npm:pi-teams
```

Create a team, then spawn teammates with absolute working directories:

```js
team_create({ team_name: "my-team" })
spawn_teammate({
  team_name: "my-team",
  name: "reviewer",
  prompt: "Review the authentication code and report concrete findings.",
  cwd: "/absolute/path/to/project"
})
```

A team can be created without a terminal adapter, but `spawn_teammate` and
`create_predefined_team` need one. A teammate's initial prompt is placed in
its transient inbox. On startup it receives an instruction to call
`read_inbox`; there is no automatic tool call and no automatic started event
in the lead's inbox. Idle agents poll inboxes about every 30 seconds.

Use `check_teammate` for runtime health, not task progress:

```js
check_teammate({ team_name: "my-team", agent_name: "reviewer" })
read_inbox({ team_name: "my-team" })
```

`check_teammate` combines terminal liveness, unread messages, startup timing,
and heartbeat telemetry. It does not inspect whether a task is complete.

## Recovering a killed Pi process

A process kill is not a PiTeams shutdown. To resume a lead, start `pi -r` in
its project directory and select the lead's prior Pi session. PiTeams matches
the selected durable session file, updates the lead PID and tmux pane, and
restores lead inbox polling.

To resume a tmux teammate whose pane exited, create a new pane in the same
project directory, run `pi -r`, and select that teammate's prior session.
PiTeams recorded the teammate's durable session file at its first startup, so
it restores the teammate identity and refreshes the tracked tmux pane/runtime
record without `PI_TEAM_NAME` or `PI_AGENT_NAME`.

Teams created by an older PiTeams version, or a teammate killed before its
first startup completes, have no recorded teammate session file. Resume those
once with `PI_TEAM_NAME` and `PI_AGENT_NAME`; that startup records the binding
for later environment-free resumes. This preserves the team roster and
transient inboxes; it does not replay missed agent work or make a killed
process a graceful shutdown.

## A task workflow

Create first, then read/list and make one update at a time:

```js
const task = task_create({
  team_name: "my-team",
  subject: "Review authentication",
  description: "Inspect authentication handlers for unsafe input."
})

task_list({ team_name: "my-team" })
task_read({ team_name: "my-team", task_id: "<id-from-task_create>" })
task_update({
  team_name: "my-team",
  task_id: "<task-id>",
  owner: "reviewer"
})
```

`task_create` does not accept initial status or owner. Use `task_update` for
those fields. Its status values are `pending`, `planning`, `in_progress`,
`completed`, and `deleted`. `blocked` can appear as a derived task status but
is not writable. A task update may contain only one mutation path: split
status, ownership, claim, dependency, progress, and pending-problem writes and
re-read the version token between them.

The read result names the token `version`; the write parameter is named
`expected_version`. Copy the exact returned `version` value into the next
Beads mutation's `expected_version` field.

For a teammate that must propose work first:

```js
task_submit_plan({
  team_name: "my-team",
  task_id: "<task-id>",
  plan: "Inspect handlers; add focused tests; report findings."
})

task_evaluate_plan({
  team_name: "my-team",
  task_id: "<task-id>",
  action: "approve"
})
```

Approval changes `planning` to `in_progress`. Rejection requires `feedback`
and keeps the task in `planning`; it does not automatically start the task.
`plan_mode_required` on `spawn_teammate` records the teammate's plan-mode
setting, while plan state is changed through the two task plan tools.

Use `claim: true` for an atomic claim where supported. Use `blocked_by` to add
a dependency to the target task. Beads rejects `blocks`, because that form
would mutate a second task without a second version token. `progress` and
`pending_problem` append communicated entries rather than replacing the task
record.

## Communication and shutdown

Direct messages and broadcasts are transient coordination state:

```js
send_message({
  team_name: "my-team",
  recipient: "reviewer",
  content: "Please prioritize the session validation path.",
  summary: "Prioritize session validation"
})

broadcast_message({
  team_name: "my-team",
  content: "The test environment is ready.",
  summary: "Test environment ready"
})
```

`send_message` has no `color` parameter; `broadcast_message` optionally does.
Use `read_inbox` to inspect messages. Inbox state is separate from task state.

When one teammate is finished, use:

```js
process_shutdown_approved({ team_name: "my-team", agent_name: "reviewer" })
```

For the whole team:

```js
team_shutdown({ team_name: "my-team" })
```

Whole-team shutdown attempts process and pane/window cleanup and removes old
Pi agent-session folders older than one hour. A legacy team loses its team and
local task directories as part of normal cleanup. A Beads-cutover team keeps
its team configuration, Beads authority, and legacy task files as migration
evidence, so task data remains queryable after the panes close. Run
`cleanup_agent_sessions({ max_age_hours: 24 })` for a separate cleanup with a
custom age threshold.

## Legacy tasks and Beads cutover

Before migration, the legacy backend stores per-task JSON under
`~/.pi/tasks/<team>/` and normally assigns numeric local IDs. A migrated team
records `taskBackend: "beads"`, an absolute `taskWorkspace`, and durable
cutover evidence. From cutover onward, Beads is the only writable task
authority and task IDs are Beads IDs such as `bd-abc123`; do not use the old
numeric ID as a new task ID.

Run migration outside Pi with:

```sh
npm run migrate:tasks -- <team-name> <absolute-beads-workspace> [report-path]
```

The helper inventories and hashes legacy files, imports/reconciles by
`pi_teams_legacy_id`, maps task fields and dependencies, reconciles the result,
and flips authority only after successful reconciliation. Pre-cutover drift
blocks the flip until an explicitly reviewed operator override is recorded.
Interrupted migration can be rerun. After cutover, changed or newly created
legacy files are orphaned old-client writes and are never imported
automatically; mixed old/new writers are not a supported steady state.

For Beads writes after cutover, supply `expected_version` from a fresh
`task_read` or `task_list` result for non-claim mutations. Beads 1.1.0 does not
provide true CLI compare-and-swap, so this is a serialized preflight rather
than a guarantee against an external race. If Beads is unavailable, malformed,
times out, rejects the task's scope, or reports a conflict, the tool fails and
does not write legacy files.

Beads maps `pending` and `planning` to open issues with PiTeams metadata,
`in_progress` directly, and `completed` to closed. Plans, progress, and
pending problems use namespaced metadata/comments. `deleted` is soft deletion
in Beads, preserving history; legacy deletion removes the local task file.

After Beads-cutover shutdown, read the preserved team configuration to obtain
the absolute workspace, then query it directly:

```sh
bd --directory <taskWorkspace> --json list --label pi-teams:<team-name> --all --no-pager --limit 0
bd --directory <taskWorkspace> show <beads-id> --long --include-comments --include-dependents
bd --directory <taskWorkspace> graph --dot <beads-id> > task.dot
bd --directory <taskWorkspace> graph --html <beads-id> > task.html
```

`--all` retains closed history in the list. `bd graph --all` is an open-work
view, so graph a specific ID when closed dependencies matter.

## Completion hook

The supported hook is `.pi/team-hooks/task_completed.sh`, relative to the
current Pi process working directory. When a task is completed, PiTeams passes
the task record as JSON in the hook's first argument and sets `PI_TEAM` to the
team name.

Both task backends invoke this hook: the legacy store invokes it on a
`completed` write, while `BeadsTaskStore` invokes it when an open task
transitions to closed through completion. Hook errors are logged and do not
reverse the task mutation, so the hook is notification/automation rather than
a transactional quality gate.

```sh
#!/bin/sh
# .pi/team-hooks/task_completed.sh
printf 'completed: %s\n' "$1" >> .pi/completions.log
```

## Templates

Templates are discovered from global and project files:

- global teams: `~/.pi/teams.yaml` (with the historical
  `~/.pi/agent/teams.yaml` fallback);
- project teams: `.pi/teams.yaml`;
- global agents: `~/.pi/agent/agents/*.md` or `SKILL.md` directories;
- project agents: `.pi/agents/*.md` or `SKILL.md` directories.

Use the listing tools before creating a template-based team:

```js
list_predefined_teams()
list_predefined_agents()
create_predefined_team({
  team_name: "review-team",
  predefined_team: "security-review",
  cwd: "/absolute/path/to/project"
})
```

`create_predefined_team` attempts every agent and returns per-agent results;
one missing or failed definition does not necessarily prevent other agents
from being attempted. Agent definitions can provide prompts, models, thinking
levels, and Pi tool allowlists.

To reuse a runtime team:

```js
list_runtime_teams()
save_team_as_template({
  team_name: "my-team",
  template_name: "security-review",
  scope: "project"
})
```

Saving requires at least one spawned teammate. `scope: "user"` (the default)
writes under `~/.pi`; `scope: "project"` writes project-local definitions.

## Terminal adapters

The adapter registry checks `tmux`, Zellij, cmux, iTerm2, WezTerm, then
Windows Terminal. All can provide panes. Only cmux, iTerm2, WezTerm, and
Windows Terminal report separate OS-window support, so window flags can fail
on tmux or Zellij.

- **tmux:** requires `TMUX`; pane kill and liveness are supported; no OS
  windows.
- **Zellij:** requires `ZELLIJ` outside tmux; panes use `--close-on-exit`,
  explicit kill is a no-op, and synthetic pane liveness is best-effort.
- **cmux:** requires `CMUX_SOCKET_PATH` or `CMUX_WORKSPACE_ID` outside tmux and
  Zellij; it manages surfaces and OS windows through the `cmux` CLI.
- **iTerm2:** requires macOS iTerm2 outside tmux and Zellij; AppleScript manages
  panes and windows.
- **WezTerm:** requires `WEZTERM_PANE` and a working `wezterm` CLI outside tmux
  and Zellij; it can kill panes and closes a spawned window by killing its
  panes.
- **Windows Terminal:** requires Windows, `wt` at spawn time, and PowerShell.
  Pane/window IDs are synthetic; direct terminal kill and reliable liveness
  queries are unavailable. Process shutdown may use the tracked teammate PID,
  but terminal cleanup and `check_teammate` liveness are advisory.

Run Pi in the terminal environment you intend to manage. If no adapter is
detected, use task and messaging tools without spawning, or configure a
supported adapter before spawning.

## The 21 registered tools

`team_create`, `spawn_teammate`, `spawn_lead_window`, `send_message`,
`broadcast_message`, `read_inbox`, `task_create`, `task_submit_plan`,
`task_evaluate_plan`, `task_list`, `task_update`, `team_shutdown`,
`cleanup_agent_sessions`, `task_read`, `check_teammate`,
`process_shutdown_approved`, `list_predefined_teams`, `list_predefined_agents`,
`create_predefined_team`, `save_team_as_template`, and `list_runtime_teams`.
