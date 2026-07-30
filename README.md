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

The Task-first sequence is:

`team_create` → `worker_ensure` with an absolute `cwd` → assigned `task_create`
→ cursor-based `team_sync` → inspect evidence → resolve Tasks → stop Workers.

A minimal agent-led run looks like this:

```js
team_create({ team_name: "review" })

worker_ensure({
  team_name: "review",
  name: "auditor",
  profile: "Contract reviewer who reports reproducible evidence.",
  cwd: "/absolute/path/to/project"
})

task_create({
  team_name: "review",
  title: "Audit the recovery contract",
  description: "Compare the implementation with the documented recovery path.",
  acceptance_criteria: "Report exact files and a reproducer, or a clean result.",
  assignee: "auditor"
})

team_sync({ team_name: "review" })
// Save the returned cursor, then wait from it:
team_sync({ team_name: "review", cursor: "<returned-cursor>", wait_ms: 30000 })
```

Use the initial `team_sync` snapshot to reconcile the Team, then reuse its
monotonic cursor for event-driven waits. Inspect the authoritative Task and its
evidence after a change. A Worker either closes with completion evidence or
blocks with blocker evidence and a next action; a blocked Task requires an
explicit resolution, not an inference from terminal output.

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
pi install npm:@hypercarrier/pi-team-bright@0.16.0-rc.2
```

The package owns its local Task backend through the exact runtime dependency
`@beads/bd@1.1.0`; a separate global `bd` installation is not required.

For an upgrade or rollback, first resolve nonterminal Tasks and stop the live
Team. Install the chosen version for every participant, then create a new
single-version Team epoch. Do not update members one at a time while the Team
is live.

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
