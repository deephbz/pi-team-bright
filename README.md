# Pi Team Bright

Pi Team Bright makes **Task-first teams visible in terminal panes**. One Pi
Session leads stable Workers; the Task plus its assignee is the only executable
work contract. The extension registers ten Pi tools plus the read-only `/pi-team-bright [status|help]` command; `status` is the default.

| iTerm2 | tmux | Zellij |
| :---: | :---: | :---: |
| <a href="https://raw.githubusercontent.com/deephbz/pi-team-bright/main/iTerm2.png"><img src="https://raw.githubusercontent.com/deephbz/pi-team-bright/main/iTerm2.png" width="300" alt="Pi Team Bright in iTerm2"></a> | <a href="https://raw.githubusercontent.com/deephbz/pi-team-bright/main/tmux.png"><img src="https://raw.githubusercontent.com/deephbz/pi-team-bright/main/tmux.png" width="300" alt="Pi Team Bright in tmux"></a> | <a href="https://raw.githubusercontent.com/deephbz/pi-team-bright/main/zellij.png"><img src="https://raw.githubusercontent.com/deephbz/pi-team-bright/main/zellij.png" width="300" alt="Pi Team Bright in Zellij"></a> |

## Install

Install the published npm package, preferably pinning the release for every
member of a live Team:

```sh
pi install npm:@hypercarrier/pi-team-bright@0.16.0-rc.1
```

Or install the future GitHub repository at a tag or exact commit:

```sh
pi install git:github.com/deephbz/pi-team-bright@v0.16.0-rc.1
```

Use `-l` with either command to install it for the current project. Pi packages
run with full system access, so review an unfamiliar release before installing
it.

## Terminal carrier contract

Pi Team Bright detects one direct terminal carrier by first match: Herdr, tmux,
Zellij, cmux, iTerm2, WezTerm, then native Windows. Start or restart Pi inside
one of those carriers before creating a Team if none is detected. Terminal panes
carry Workers, but pane activity is never Task truth: the Task authority and
its accepted state remain the work record.

## First use

Create a Team, ensure a Worker with an absolute working directory, then assign
one goal-driven Task:

```js
team_create({ team_name: "my-team" })
worker_ensure({
  team_name: "my-team",
  name: "security-reviewer",
  profile: "Security reviewer who reports concrete authentication findings.",
  cwd: "/absolute/path/to/project"
})
task_create({
  team_name: "my-team",
  title: "Review authentication",
  description: "Inspect authentication handlers for unsafe input.",
  acceptance_criteria: "List every inspected handler and provide a reproducer or explicit clean result.",
  assignee: "security-reviewer"
})
```

A Worker receipt separates durable Membership creation, terminal launch, and
bounded exact-Membership runtime-startup observation without implying readiness
or progress. Window placement is a Team-wide durable configuration, not a
per-call `worker_ensure` option. Existing Teams without `separate_windows` use
panes. To adopt windows, stop the Team and create a new Team epoch with
`team_create({ separate_windows: true })`; never edit Team config or pass a
per-Worker override. Unsupported terminal carriers refuse the Team policy. A Task mutation receipt carries
its resulting authority version. Pi renders concise Accepted, Partial, or
Refused receipts separately from short italic `Hints sent to agent`; machine
next actions appear only in expanded evidence and aren't sent as hints. Use
`team_sync` to wait for Team and Task events instead of polling runtime state or
terminal output.

## Status diagnosis

`/pi-team-bright` (or `/pi-team-bright status`) reads the current Team configuration and exact Beads authority binding. It reports Team and Membership facts, Session-binding evidence, configured storage, and Beads verification state. It does not report Task emptiness, Worker readiness, runtime health, or progress.

## Update and rollback

Stop every live Team before changing its Pi Team Bright version, then restart
the Team as one version epoch. To update an unpinned npm install, run:

```sh
pi update npm:@hypercarrier/pi-team-bright
```

To pin or roll back, reinstall the exact known-good version:

```sh
pi install npm:@hypercarrier/pi-team-bright@0.16.0-rc.1
# or a GitHub tag / commit:
pi install git:github.com/deephbz/pi-team-bright@v0.16.0-rc.1
```

Pinned versions are intentionally skipped by bulk package updates. Verify the
installed source with `pi list` before restarting a Team.

## Authority and non-goals

Tasks plus exact assignees are the work protocol. Typed Alerts only handle
exceptional clarification, attention, and lead announcements among current
Team members; they never assign, advance, or complete work. Beads is the sole
runtime Task authority. Pi Team Bright installs the pinned `@beads/bd@1.1.0`
CLI as a runtime dependency, so npm and Git installs don't require a separate
global `bd` installation. Its installer acquires the matching native binary for
supported x64 and arm64 macOS, Linux, Windows, and Android Node platforms.

Pi Team Bright deliberately does not provide a general agent directory,
cross-Team routing, freeform work by message, inbox polling, runtime polling as
progress, or terminal activity as Task evidence. Team topology and lifecycle
writes are lead-only; Worker and Team shutdown fail closed unless
Membership-bound stop evidence confirms the stop.

## Documentation

Start with the maintained [evergreen context](docs/current/README.md). The
[contract source map](docs/reference.md) routes to executable schemas, types,
and implementations. The packaged operator and agent documentation is
intentionally kept separate from private maintainer history.

## License

[MIT](LICENSE)


## Test lanes

`npm test` is the fast deterministic lane, not exhaustive. Use `npm run test:exhaustive-only` for excluded integration/contract/e2e and QA tests, `npm run test:full` for all tests, and `npm run test:lanes` to verify lane closure.
