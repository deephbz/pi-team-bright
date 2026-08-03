# Pi Team Bright

**Delegate work to a visible Pi team without turning terminal activity into your
source of truth.**

Pi Team Bright lets one Pi lead assign durable Tasks to stable, named Workers.
Workers remain visible through terminal adapters, but the work lives in the
Task: who owns it, what done means, and the evidence that closed or blocked it.
The lead can wait for changes instead of watching panes.

## From terminal juggling to accountable delegation

Suppose a release needs two things at once: an API-contract audit and a rollback
checklist update.

**Before:** the operator opens extra terminals, pastes two prompts, and watches
scrolling output. One process exits and another looks busy, but there is no
reliable answer to “Who owns which result?”, “What is still blocked?”, or “What
proved completion?”

**With Pi Team Bright:** the lead ensures an `auditor` and a `writer`, then
creates one assigned Task for each outcome with explicit acceptance criteria.
The auditor closes with file-and-command evidence. The writer blocks with the
missing decision, blocker evidence, and a next action. The lead observes those
state changes through `team_sync`, resolves the blocker, and reviews the Task
evidence before stopping either Worker.

A pane, process, launch receipt, or startup observation may show that a carrier
exists. None of them proves that a Worker is ready, making progress, or done.
The Task plus its assignee is the only executable work contract.

## The normal flow

The release-candidate sequence is:

`team_create` → `ensure_worker` → assigned `task_create` → snapshot and updates
through `team_sync` → inspect evidence → resolve Tasks → `worker_stop` or
`team_shutdown`.

A minimal agent-led run looks like this:

```js
team_create({ name: "review", purpose: "Audit the recovery contract." })

ensure_worker({
  name: "auditor",
  scope: "Contract reviewer who reports reproducible evidence."
})

task_create({
  tasks: [{
    title: "Audit the recovery contract",
    goal: "Compare implementation with the documented recovery path and report exact evidence.",
    assignee: "auditor"
  }]
})

team_sync({ view: "snapshot" })
team_sync({ view: "updates" })
```

Use the initial `team_sync` snapshot to reconcile the Team, then use updates
for event-driven supervision. Inspect the authoritative Task and its evidence
after a change. A Worker either closes with completion evidence or blocks with a
next action; a blocked Task requires an explicit resolution, not an inference
from terminal output.

Reuse Workers across Tasks. Before `worker_stop`, resolve every nonterminal Task
assigned to that Worker. Reconcile once more before `team_shutdown`.

Alerts are only for exceptional clarification, attention, or announcements.
They never assign, advance, block, or complete work, and they are not a chat-
based substitute for Tasks.

## Candid limits

- **This is Team-scoped coordination.** It is not a general agent directory,
  cross-Team router, universal chat bus, or freeform work-by-message system.
- **Terminal capabilities vary.** Herdr, tmux, Zellij, cmux, iTerm2, WezTerm,
  and Windows adapters do not all have identical spawn, stop, nesting, or
  window support. Placement is Team-wide policy, never a per-Worker override;
  an unsupported policy is refused.
- **One live Team is one version epoch.** There is no rolling mix of Pi Team
  Bright versions. Stop the Team before an upgrade or rollback, then restart
  it on one version.
- **Visibility is not progress.** Launch, delivery, process, runtime, pane, and
  window evidence is bounded evidence about those things only. Likewise,
  `/pi-team-bright status` and `/pi-team-bright help` provide bounded local
  diagnosis; they are not Worker health, readiness, or progress checks.
- **Beads list contention is unresolved.** While live Workers settle Tasks,
  ordinary `team_sync` can intermittently time out in the underlying Beads
  `list` command. Do not interpret that timeout as an empty Task set, Worker
  failure, or lack of progress; preserve the last valid cursor and reconcile
  from authoritative state when the read is available.
- **The packaged operating skill is currently named `pi-teams`.** The product,
  command, and npm package use Pi Team Bright naming, but the skill rename is
  still TODO.

## Install and upgrade

After npm lists this release candidate, pin the exact version:

```sh
pi install npm:@hypercarrier/pi-team-bright@0.17.0-rc.2
```

The package owns its local Task backend through the exact runtime dependency
`@beads/bd@1.1.0`; a separate global `bd` installation is not required.

For an upgrade or rollback, first resolve nonterminal Tasks and stop the live
Team. Install the chosen version for every participant, then create a new
single-version Team epoch. Do not update members one at a time while the Team
is live.

## Worker resource settings

Worker-only prompt and tool projection uses Pi settings, not Team state. Put it under
`pi_team_bright.worker` in Pi global `~/.pi/agent/settings.json`, or in a trusted
project's `.pi/settings.json`. Pi applies its normal global/project merge, so the
trusted project's nested Worker values take precedence. No Pi Team Bright settings
file exists.

```json
{
  "pi_team_bright": {
    "worker": {
      "agents": {
        "replace_global": "/absolute/path/to/worker-global.md",
        "append_global": "/absolute/path/to/worker-append.md"
      },
      "tools": { "enable": ["grep"], "disable": ["bash"] }
    }
  }
}
```

Both `agents` paths are optional and must be absolute. The four cases are:

- Neither: native global plus ancestor/project context stays unchanged.
- `append_global`: native global plus ancestor/project context, then the append file.
- `replace_global`: the replacement file, then native ancestor/project context.
- Both: the replacement file, native ancestor/project context, then the append file.

An unreadable `replace_global` warns and restores the native global contribution.
An unreadable `append_global` warns and skips only the append file. Pi Team Bright
serializes an active aggregate in a private temporary file and launches Workers
with `--no-context-files --append-system-prompt`; Pi reports appended content and
`getAgentsFiles` is empty. Tool disable wins over enable. Tool projection changes
only the model-visible active set. It never grants authorization: core services,
including Alert authorization, still reject forged or prohibited calls.

A saved Pi trust decision controls project settings. A trusted Worker gets
`--approve`. An untrusted or unknown Worker gets `--no-approve`; an unknown cwd
uses global settings only and warns. Save trust then restart.
The aggregate covers normal and Task-delivery trigger turns. On Worker reload,
Pi Team Bright atomically refreshes the fixed aggregate path. If both paths then
disappear, it restores serialized native global plus ancestor/project context.
A final Worker shutdown removes its aggregate on a best-effort basis. A failed
launch removes it only when no carrier exists or terminal stop is confirmed. If
a carrier can remain live, Pi Team Bright retains its aggregate lease. Restart
without an aggregate restores Pi's native `getAgentsFiles` metadata. The lead is
unchanged.

## Architecture and authority boundaries

Pi Team Bright keeps coordination concepts separate so that convenient
observations do not become accidental authority:

| Concern | What it means |
|---|---|
| **Team and Membership** | The durable roster, lifecycle, current Membership generation, and Team-wide placement policy. |
| **Pi Session identity** | The exact conversational Session bound to a current Membership; a matching name, process, pane, or environment variable is not identity proof. |
| **Task authority** | Durable Task content, assignee, status, relations, versions, and evidence, owned by the Team's local Beads backend. |
| **Delivery** | Presentation of a Task change or Alert to one exact Session. A delivery receipt never changes Task state. |
| **Runtime observation** | Bounded evidence that an exact Membership process generation was observed. It does not prove readiness or progress. |
| **Terminal surface** | An adapter-owned pane or window carrying a Worker process. It is replaceable and is neither Worker identity nor work state. |
| **Events and `team_sync`** | The projection, cursor, and wait boundary that wakes the lead. Events report changes; Team and Task authorities still own current state. |

Terminal surfaces may be replaced while the stable Worker and its assigned Task
remain the coordination concepts the operator reasons about. Exact schemas,
guards, and lifecycle behavior live in executable contracts rather than this
README.

## Security and local data

Pi packages run with **full system access** as the user running Pi. Pi Team
Bright is not a sandbox: review the package and release before installing it,
and only run Workers in directories they should be allowed to access.

Team/Membership configuration, event and delivery records, runtime observations,
and the Team-owned Beads Task data are local machine state. Terminal adapters
also control processes and surfaces in their host applications. Treat those
files, processes, prompts, and Task evidence according to the sensitivity of
the project.

Report suspected vulnerabilities privately as described in
[SECURITY.md](.github/SECURITY.md); do not open a public vulnerability issue.

## Verification and exact contracts

From a source checkout, use the verification lane appropriate to the change:

```sh
npm run typecheck
npm test
npm run test:full
npm run verify:package
```

`npm test` is the fast deterministic lane; `npm run test:full` includes the
broader suite, and `npm run verify:package` probes the packed public artifact.

For current stage, constraints, and open work, read the
[maintained context](docs/current/README.md). For one-hop links to tool schemas,
authority implementations, types, event semantics, adapters, and focused tests,
use the [contract source map](docs/reference.md).

## Credits

Pi Team Bright is maintained by the HyperCarrier project. It derives from
[pi-teams](https://github.com/burggraf/pi-teams) by Mark Burggraf, a Pi port of
[claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp)
by Victor (`cs50victor`). The original MIT copyright notice is retained in
[LICENSE](LICENSE).

## TODO

- Rename the packaged operating skill from `pi-teams` to `pi-team-bright` while
  retaining stable compatibility identities where required.
- Isolate Task projection availability from valid Team and Worker carrier state
  when the underlying Beads list read is contended.
