# Pi Team Bright

Pi Team Bright gives a Pi lead durable delegated work that stays visible in
terminal panes. The lead can create named Workers, assign exact Tasks, wait for
state changes, and handle exceptional clarification without using terminal
activity as a substitute for progress.

## What it does

- **Tasks own the work.** A Task plus its assignee is the only delegation
  contract. Workers close with evidence or block with blocker evidence and a
  next action.
- **Beads owns Task state.** The pinned `@beads/bd@1.1.0` runtime dependency
  provides the local Task backend; no separate global `bd` install is needed.
- **Workers stay visible.** Pi Team Bright carries Workers in Herdr, tmux,
  Zellij, cmux, iTerm2, WezTerm, or native Windows panes. Separate windows are
  an optional Team-wide policy.
- **Leads wait on events.** `team_sync` observes Team and Task changes without
  inbox or runtime polling. Typed Alerts get attention for clarification or
  announcements, but never assign or complete work.
- **State stays inspectable.** `/pi-team-bright [status|help]` reports Team,
  Membership, Session-binding, storage, and Beads authority facts without
  claiming Worker readiness or progress.

The PiTeams demo follows a typical agent-led flow: after the operator describes
an outcome, the lead creates two durable Workers, one Task closes with evidence
while another blocks for clarification, and the lead observes the resolution
through `team_sync`.

## Install

Pin the release for every member of a live Team:

```sh
pi install npm:@hypercarrier/pi-team-bright@0.16.0-rc.2
```

Pi packages run with full system access, so review a release before installing
it. Stop live Teams before updating or rolling back, then restart them as one
version epoch.

## First use

```js
team_create({ team_name: "review" })
worker_ensure({
  team_name: "review",
  name: "researcher",
  profile: "Researcher who reports concrete evidence.",
  cwd: "/absolute/path/to/project"
})
task_create({
  team_name: "review",
  title: "Verify the recovery contract",
  description: "Inspect the implementation and recovery checklist.",
  acceptance_criteria: "Report exact files and a reproducer or clean result.",
  assignee: "researcher"
})
```

Reuse stable Workers, assign executable work only through Tasks, and use Alerts
only for exceptional attention. Use the returned `team_sync` cursor to wait for
what changes.

## TODO

The packaged skill is still publicly named `pi-teams`. A future release should
rename that user-facing skill to `pi-team-bright`; stable `pi-teams-*`
protocol, provider, and storage identities will remain unchanged for
compatibility.

## Credits

Pi Team Bright is maintained by the HyperCarrier project. It derives from
[pi-teams](https://github.com/burggraf/pi-teams) by Mark Burggraf, which is a Pi
port of [claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp)
by Victor (`cs50victor`). The original MIT copyright notice is retained in
[LICENSE](LICENSE).

For exact contracts and operational limits, read the
[reference](docs/reference.md) and [maintained context](docs/current/README.md).
