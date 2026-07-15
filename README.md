# pi-teams 🚀

**pi-teams** turns a Pi session into a coordinated software team. It manages
team membership, terminal panes/windows, transient inboxes, runtime health, and
a shared task workflow. The extension registers exactly 18 Pi tools; it does
not add slash commands.

| iTerm2 | tmux | Zellij |
| :---: | :---: | :---: |
| <a href="https://raw.githubusercontent.com/deephbz/pi-teams/main/iTerm2.png"><img src="https://raw.githubusercontent.com/deephbz/pi-teams/main/iTerm2.png" width="300" alt="pi-teams in iTerm2"></a> | <a href="https://raw.githubusercontent.com/deephbz/pi-teams/main/tmux.png"><img src="https://raw.githubusercontent.com/deephbz/pi-teams/main/tmux.png" width="300" alt="pi-teams in tmux"></a> | <a href="https://raw.githubusercontent.com/deephbz/pi-teams/main/zellij.png"><img src="https://raw.githubusercontent.com/deephbz/pi-teams/main/zellij.png" width="300" alt="pi-teams in Zellij"></a> |

It also supports cmux, WezTerm, and Windows Terminal through adapter-specific
capabilities.

## Installation

```sh
pi install git:github.com/deephbz/pi-teams@v0.11.0-hypercarrier.0
```

This is the HyperCarrier fork. `npm:pi-teams` currently resolves to the
upstream package and does not include this fork's Beads and session-recovery
work.

Alpha upgrades are clean-cut epochs, not rolling upgrades: stop every process
in a team before changing the installed PiTeams version, run any required
out-of-band Task migration, then restart the whole team on one version. Mixed
old/new live team processes aren't supported.

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
  title: "Review authentication",
  description: "Inspect authentication handlers for unsafe input.",
  assignee: "security-reviewer"
})
```

A teammate's initial prompt is accepted into its transient inbox and delivered
as a native custom steer with its stable Message ID and full body. Task changes
use a separate native custom steer backed by Beads Task authority; neither path
requires a model-issued `read_inbox` call. Use `check_teammate` only for
on-demand runtime diagnosis, and query `task_list`/`task_read` only when current
Task authority state is actually needed.

## Core workflows

- **Parallel specialists:** `spawn_teammate` accepts per-agent model,
  thinking, working directory, and optional separate-window settings. Its
  receipt distinguishes durable Membership persistence, terminal launch,
  initial Message acceptance, and runtime/presentation observations; spawn
  doesn't wait for or claim runtime readiness.
- **Task coordination:** use `task_create` and `task_update`; query with
  `task_list`/`task_read` when needed. Create starts `open` and may include
  prose `design` plus an `assignee`. `task_update` changes content, work state,
  assignment, or appends native Beads notes; `task_link` owns the separate
  `blocked_by`, `parent`, and `related` graph relations. Mutation receipts
  contain concise post-state and applied operations, so don't immediately
  re-read or list the same result.
- **Optional review:** simple work can be claimed or moved directly to
  `in_progress`. When the assigner judges a Task complex, the worker supplements
  its `design`, sends a Message referencing the Task ID/version, and waits for
  feedback. Approval is an exact-version transition to `in_progress`; rejection
  appends feedback while the Task remains `open`. Review is a collaboration
  convention, not a universal mechanical gate or a separate Plan object.
- **Messaging:** `send_message` and `broadcast_message` manage substantive
  transient coordination; avoid ACK-only Messages unless semantic confirmation
  is required. `read_inbox` is explicit audit/history inspection only, never a
  delivery fetch. Direct and broadcast receipts expose accepted stable
  Message IDs; broadcast partial failures are recipient-specific. Foreign
  inbox inspection is non-consuming.
- **Runtime health:** `check_teammate` reports terminal liveness, inbox state,
  startup status, and heartbeat telemetry. It is an on-demand diagnostic, not
  routine progress/completion polling.
- **Shutdown:** `teammate_shutdown` handles one teammate;
  `team_shutdown` handles the team without global age-based artifact deletion.
  A Membership is deactivated only after its terminal surface is confirmed gone,
  or an exact Membership-bound runtime record proves that its process already
  exited. Failed stops remain current and are reported for retry.
  `report_stale_agent_sessions` only reports old Pi-core folders for review.
- **Mutation authority:** Team topology, lifecycle, and template writes are
  lead-only. Teammates keep the full Task and Communication surfaces.
- **Process recovery:** after a killed Pi process, resume the same Pi session
  with `pi -r`. PiTeams records each member's durable Pi session file at first
  startup, so both leads and teammates reclaim their identity and refresh their
  tmux/runtime state without manually supplying team environment variables. If
  one lead Session is recorded for multiple teams, resume fails closed until
  `PI_TEAM_NAME` explicitly selects the intended current team.
- **Templates:** `list_predefined_teams`, `list_predefined_agents`,
  `create_predefined_team`, and `save_team_as_template` support reusable team
  definitions. Saving is restricted to the Team currently bound to the exact
  Pi Session; `dry_run` returns exact paths and contents without writing.
  Persisted historical Team configs are not an agent-facing list.

See [docs/guide.md](docs/guide.md) for workflows and
[docs/reference.md](docs/reference.md) for every parameter. The exact-binding
Team/role footer projection and its Pi API limitation are documented in
[docs/team-footer.md](docs/team-footer.md).

## Beads task authority

Every new team's own directory, `~/.pi/teams/<team>`, is its default Beads
workspace. `team_create` initializes it automatically, without
generating Beads agent files or hooks, then records its exact authority
identity before exposing the Team as created. `PI_TEAMS_BEADS_WORKSPACE` is an
optional explicit override for an already initialized external workspace.
An override must contain its own Beads 1.1 `.beads/metadata.json`, and `bd where`
must resolve back to that exact directory; PiTeams never accepts ancestor
discovery as the Team's Task authority.
Historical teams that still have JSON files under `~/.pi/tasks/<team>/` are
read only by the explicit one-time migration command:

```sh
npm run migrate:tasks -- <team-name> <absolute-beads-workspace> [report-path]
```

The team config records `taskBackend: "beads"`, an absolute `taskWorkspace`, a
stable opaque `taskAuthorityId`, a versioned `taskAuthorityFingerprint` bound
to the Beads project/database identity, plus durable cutover evidence for
migrated teams.
An idempotent migration rerun must name that exact workspace; it reconciles the
persisted legacy-to-Beads mapping and fails closed if the path differs or the
configured authority workspace is unavailable. It also requires the preserved
`taskAuthorityId` and fingerprint; migration rerun never invents a replacement
identity or accepts a different valid database swapped into the same path.
Beads is the sole runtime Task authority; newly created or changed legacy files
are never imported automatically. Task IDs are Beads IDs (for example
`bd-abc123`). `expected_version` is optional and enforced when supplied. If
Beads fails, PiTeams fails rather than writing legacy files.

A Beads-cutover team's task authority survives `team_shutdown`. Inspect it
using the preserved workspace from the team configuration:

```sh
bd --directory <taskWorkspace> --json list --label pi-teams:<team-name> --all --no-pager --limit 0
bd --directory <taskWorkspace> show <beads-id> --long --include-comments --include-dependents
bd --directory <taskWorkspace> graph --dot <beads-id> > task.dot
```

Set `PI_TEAMS_TRACE_JSONL` to an absolute path for opt-in, payload-free
canonical operation records. Each JSONL record includes semantic operation
duration, Beads verb timings/count, lock wait, and outcome/error class; Task
descriptions, comments, metadata values, credentials, and command arguments are
never written.

## Closed-Task hook

The Beads Task adapter supports `.pi/team-hooks/task_closed.sh`. When a Task
transitions to `closed`, PiTeams passes the Task JSON as the first argument and sets
`PI_TEAM`. Hook failures are logged and do not roll back the Task mutation.

## Terminal support and limitations

The registry detects adapters in this order: `tmux`, Zellij, cmux, iTerm2,
WezTerm, then Windows Terminal.

| Adapter | Panes | Separate OS windows | Important limitation |
| --- | --- | --- | --- |
| tmux | Yes | No | Requires `TMUX`. |
| Zellij | Yes | No | Requires `ZELLIJ`; synthetic IDs cannot prove an explicit pane stop, so shutdown fails closed until the process exits. |
| cmux | Yes | Yes | Requires cmux environment variables and CLI. |
| iTerm2 | Yes | Yes | macOS iTerm2 and AppleScript; not nested in tmux/Zellij. |
| WezTerm | Yes | Yes | Requires `WEZTERM_PANE` and the `wezterm` CLI. |
| Windows Terminal | Yes | Yes | Requires `wt` and PowerShell; synthetic IDs cannot prove an explicit pane/window stop, so shutdown fails closed until the process exits. |

`separate_window` and `separate_windows` are requests. PiTeams rejects them
when the selected adapter reports no OS-window support. PiTeams never kills a
PID merely because it appears in a durable file: PID reuse makes that unsafe.
For Windows Terminal and Zellij, close the teammate process manually and retry
shutdown; an exact Membership-bound runtime record can then prove that the
recorded process has exited and allow Membership deactivation.

## Registered tool surface

The 18 registered tools are:

```text
team_create
spawn_teammate
send_message
broadcast_message
read_inbox
task_create
task_list
task_update
task_link
team_shutdown
report_stale_agent_sessions
task_read
check_teammate
teammate_shutdown
list_predefined_teams
list_predefined_agents
create_predefined_team
save_team_as_template
```

## Credits and attribution

This fork descends from
[Mark Burggraf's PiTeams port](https://github.com/burggraf/pi-teams) of
[cs50victor's claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp).
The original project's MIT notice is preserved verbatim in [LICENSE](LICENSE);
the current package author and repository fields identify the port author and
this maintained fork rather than replacing that copyright notice.

## License

[MIT](LICENSE)
