# pi-teams 🚀

**pi-teams** turns a Pi session into a coordinated software team. It manages
team membership, terminal panes/windows, transient inboxes, runtime health, and
a shared task workflow. The extension registers exactly 21 Pi tools; it does
not add slash commands.

| iTerm2 | tmux | Zellij |
| :---: | :---: | :---: |
| <a href="iTerm2.png"><img src="iTerm2.png" width="300" alt="pi-teams in iTerm2"></a> | <a href="tmux.png"><img src="tmux.png" width="300" alt="pi-teams in tmux"></a> | <a href="zellij.png"><img src="zellij.png" width="300" alt="pi-teams in Zellij"></a> |

It also supports cmux, WezTerm, and Windows Terminal through adapter-specific
capabilities.

## Installation

```sh
pi install git:github.com/deephbz/pi-teams@v0.10.0-hypercarrier.0
```

This is the HyperCarrier fork. `npm:pi-teams` currently resolves to the
upstream package and does not include this fork's Beads and session-recovery
work.

## Quick start

Create a team, spawn a teammate, and create a task through Pi:

```js
team_create({ team_name: "my-team" })
spawn_teammate({
  team_name: "my-team",
  name: "security-reviewer",
  prompt: "Review authentication code and report concrete findings.",
  cwd: "/absolute/path/to/project"
})
task_create({
  team_name: "my-team",
  subject: "Review authentication",
  description: "Inspect authentication handlers for unsafe input."
})
```

A teammate's initial prompt is written to its transient inbox and startup
injects an instruction to call `read_inbox`. PiTeams does not make that tool
call automatically and does not create a started message in the lead's inbox.
Idle agents poll inboxes about every 30 seconds. Use `check_teammate` for
runtime health and `task_list`/`task_read` for task state.

## Core workflows

- **Parallel specialists:** `spawn_teammate` accepts per-agent model,
  thinking, working directory, and optional separate-window settings.
- **Task coordination:** use `task_create`, `task_list`, `task_read`, and
  `task_update`. Create starts at `pending`; ownership and status are updated
  separately. Each `task_update` call performs one mutation path.
- **Plans:** `task_submit_plan` sets `planning`; approval sets
  `in_progress`; rejection requires feedback and keeps `planning`.
- **Messaging:** `send_message`, `broadcast_message`, and `read_inbox` manage
  transient coordination. Direct messages have no color field; broadcasts may
  specify one.
- **Runtime health:** `check_teammate` reports terminal liveness, inbox state,
  startup status, and heartbeat telemetry. It is not task progress.
- **Shutdown:** `process_shutdown_approved` handles one teammate;
  `team_shutdown` handles the team. `cleanup_agent_sessions` can clean old
  orphaned Pi agent-session folders independently.
- **Process recovery:** after a killed Pi process, resume the same Pi session
  with `pi -r`. PiTeams records each member's durable Pi session file at first
  startup, so both leads and teammates reclaim their identity and refresh their
  tmux/runtime state without manually supplying team environment variables.
- **Templates:** `list_predefined_teams`, `list_predefined_agents`,
  `create_predefined_team`, `save_team_as_template`, and `list_runtime_teams`
  support reusable team definitions.

See [docs/guide.md](docs/guide.md) for workflows and
[docs/reference.md](docs/reference.md) for every parameter.

## Beads task authority

A team initially uses the legacy JSON task store under
`~/.pi/tasks/<team>/`, whose IDs are normally local numeric strings. Migrate a
team explicitly:

```sh
npm run migrate:tasks -- <team-name> <absolute-beads-workspace> [report-path]
```

After a successful cutover, the team config records `taskBackend: "beads"`, an
absolute `taskWorkspace`, and durable cutover evidence. Beads becomes the sole
writable authority and newly created or changed legacy files are never imported
automatically. Task IDs are then Beads IDs (for example `bd-abc123`), not
local numeric IDs. Non-claim Beads writes require `expected_version` from a
fresh `task_read` or `task_list` result. If Beads fails, PiTeams fails rather
than writing legacy files.

A Beads-cutover team's task authority survives `team_shutdown`. Inspect it
using the preserved workspace from the team configuration:

```sh
bd --directory <taskWorkspace> --json list --label pi-teams:<team-name> --all --no-pager --limit 0
bd --directory <taskWorkspace> show <beads-id> --long --include-comments --include-dependents
bd --directory <taskWorkspace> graph --dot <beads-id> > task.dot
```

## Completion hook

Both task backends support `.pi/team-hooks/task_completed.sh`. On completion,
PiTeams passes the task JSON as the first argument and sets `PI_TEAM`. The
legacy store invokes it on a completed write; Beads invokes it when an open
task transitions to closed. Hook failures are logged and do not roll back the
task mutation.

## Terminal support and limitations

The registry detects adapters in this order: `tmux`, Zellij, cmux, iTerm2,
WezTerm, then Windows Terminal.

| Adapter | Panes | Separate OS windows | Important limitation |
| --- | --- | --- | --- |
| tmux | Yes | No | Requires `TMUX`. |
| Zellij | Yes | No | Requires `ZELLIJ`; close-on-exit and synthetic liveness are best-effort. |
| cmux | Yes | Yes | Requires cmux environment variables and CLI. |
| iTerm2 | Yes | Yes | macOS iTerm2 and AppleScript; not nested in tmux/Zellij. |
| WezTerm | Yes | Yes | Requires `WEZTERM_PANE` and the `wezterm` CLI. |
| Windows Terminal | Yes | Yes | Requires `wt` and PowerShell; IDs are synthetic, so terminal kill/liveness is advisory. |

`separate_window` and `separate_windows` are requests. PiTeams rejects them
when the selected adapter reports no OS-window support. Windows Terminal can
still use the tracked teammate PID during shutdown, but its CLI does not offer
the same direct window/pane kill and liveness guarantees as the other window
adapters.

## Registered tool surface

The 21 registered tools are:

```text
team_create
spawn_teammate
spawn_lead_window
send_message
broadcast_message
read_inbox
task_create
task_submit_plan
task_evaluate_plan
task_list
task_update
team_shutdown
cleanup_agent_sessions
task_read
check_teammate
process_shutdown_approved
list_predefined_teams
list_predefined_agents
create_predefined_team
save_team_as_template
list_runtime_teams
```

## License

MIT
