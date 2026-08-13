# Pi Team Bright

**Delegate work to a visible Pi team without turning terminal activity into your
source of truth.**

Pi Team Bright lets one Pi lead assign durable Tasks to stable, named Workers.
Workers remain visible through terminal adapters, but the work lives in the
Task: who owns it, what done means, and the evidence that achieved, failed, or blocked its goal.
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
The auditor reports `goal_achieved` with file-and-command evidence. The writer
blocks with the missing decision, blocker evidence, and a next action. The lead observes those
state changes through `team_sync`, resolves the blocker, and reviews the Task
evidence before stopping either Worker.

A pane, process, launch receipt, or startup observation may show that a carrier
exists. None of them proves that a Worker is ready, making progress, or done.
The Task plus its assignee is the only executable work contract.

## The normal flow

The release-candidate sequence is:

`team_create` → `ensure_worker` → `task_graph_apply` → snapshot and updates
through `team_sync` → inspect goal evidence → resolve Tasks → `worker_stop` or
`team_shutdown`.

A minimal agent-led run looks like this:

```js
team_create({ name: "review", purpose: "Audit the recovery contract." })

ensure_worker({
  name: "auditor",
  scope: "Contract reviewer who reports reproducible evidence."
})

task_graph_apply({
  operation_id: "audit-recovery-contract-1",
  tasks: [{
    key: "audit",
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
after a change. A Worker reports `goal_achieved` or `goal_failed` with evidence,
or blocks with a next action. A blocked Task requires an explicit resolution, not an inference
from terminal output.

Reuse Workers across Tasks. Before `worker_stop`, resolve every nonterminal Task
assigned to that Worker. Reconcile once more before `team_shutdown`.

Alerts are only for exceptional clarification, attention, or announcements.
They never assign, advance, block, or complete work, and they are not a chat-
based substitute for Tasks.

## Candid limits

- **This is Team-scoped coordination.** It is not a general agent directory,
  cross-Team router, universal chat bus, or freeform work-by-message system.
- **Terminal capabilities vary.** Herdr and tmux enforce the Team pane-placement
  invariant: the first Worker splits the exact leader pane right with a measured
  ratio that keeps the leader at least at its configured share. Linear placement
  splits an exact current Worker pane down; Herdr grid placement creates a deterministic Worker
  grid. Every target is checked against the leader tab and Worker region. They never use terminal
  focus, select a whole-window layout, or close another pane during
  Worker stop. iTerm2, Zellij, cmux, WezTerm, and Windows preserve their existing
  placement behavior but do not guarantee this exact target-and-ratio invariant.
  Herdr owns the `pi` executable used by `agent start`; a real Herdr Team must
  configure that executable to a supported Pi release (0.83.x or later). Pi 0.83 or later is required for
  exact Worker run-state evidence. Launching a supported local Pi only for the leader does not change
  Worker Pi. Workers load the exact Pi Team Bright extension and retain Pi's
  normal unrelated extension and Skill discovery. A distinct discovered Pi Team
  Bright copy violates the one-version-epoch rule and remains a documented
  installation risk. Herdr forwards the established Pi launch environment
  allowlist into Worker launches.
  Placement remains Team-wide policy, never a per-Worker override; an unsupported
  policy is refused.
- **Package version is not Team storage compatibility.** Existing Team records
  remain usable across compatible upgrades and rollbacks. Historical
  `implementationVersion` values are accepted as provenance, not used as a
  capability gate.
- **Visibility is not progress.** Launch, delivery, process, runtime, pane, and
  window evidence is bounded evidence about those things only. Likewise,
  `/pi-team-bright status` and `/pi-team-bright help` provide bounded local
  diagnosis; they are not Worker health, readiness, or progress checks.
- **Beads list contention is unresolved.** While live Workers settle Tasks,
  ordinary `team_sync` can intermittently time out in the underlying Beads
  `list` command. Do not interpret that timeout as an empty Task set, Worker
  failure, or lack of progress; preserve the last valid cursor and reconcile
  from authoritative state when the read is available.
- **The packaged operating skill is named `pi-team-bright`.** Its discovery
  name now matches the product, command, and npm package.

## Install and upgrade

After npm lists this release candidate, pin the exact version:

```sh
pi install npm:@hypercarrier/pi-team-bright@0.17.0-rc.15
```

The package owns its local Task backend through the exact runtime dependency
`@beads/bd@1.1.0`; a separate global `bd` installation is not required.

For an upgrade or rollback, restart each Pi process that must load the chosen
extension. Do not recreate the Team only because the package version changed.
Stop or migrate a Team only when release notes identify a real persistence
contract change, or when a Team policy requires a new epoch.

## Team pane layout settings

Set the optional Team policy under `pi_team_bright.team` in global
`settings.json` or a trusted project's `.pi/settings.json`. Pane layout values
use Pi's normal trusted-project precedence. Sync liveness values are read from
global settings only. This complete example also shows the related Worker settings:

```json
{
  "pi_team_bright": {
    "team": {
      "pane_layout": {
        "leader_share": 0.6,
        "worker_tiling": "grid"
      },
      "wait_seconds": 120,
      "nudge_enabled": true,
      "nudge_delay_seconds": 1200
    },
    "worker": {
      "default_model": "openai-codex/gpt-5.6-luna",
      "agents": {
        "append_global": "/absolute/path/to/worker-AGENTS.md"
      },
      "tools": {
        "enable": ["tool-name"],
        "disable": ["tool-name"]
      }
    }
  }
}
```

`leader_share` is the fraction kept by the leader after the first Worker split.
It must be greater than `0.1` and less than `1.0`; the default is `0.6`.
`team_create.pane_layout` takes precedence over trusted project settings, then
global settings, then `{ "leader_share": 0.6, "worker_tiling": "linear" }`.
Herdr supports `linear` and `grid`; other pane backends support `linear` only.
The resolved policy is stored in `TeamConfig`, so later settings changes do not
move a live Team. `wait_seconds` defaults to `120`. Nudge settings default to
enabled with a `1200` second delay. Malformed nudge values use these defaults and
emit diagnostics; set `nudge_enabled` to `false` to disable nudges.
Stop and recreate the Team to apply a new policy.

## Worker resource settings

Worker-only prompt, tool, and default-model projection uses Pi settings. Put it under
`pi_team_bright.worker` in the active Pi agent directory's `settings.json`
(`PI_CODING_AGENT_DIR`, normally `~/.pi/agent`), or in a trusted project's
`.pi/settings.json`. Pi applies its normal global/project merge, so the trusted
project's nested Worker values take precedence. No Pi Team Bright settings file exists.
Replace the example's model, absolute prompt path, and tool names with values
available in the Worker environment.

`default_model` is optional and applies only to new Workers. Its first slash
separates a provider from a nonempty model ID; the model ID can contain later
slashes, for example `openrouter/openai/gpt-5.1`. Pi Team Bright requires the
exact available identifier and never selects a provider for this setting. Explicit Worker or template models and the durable Team `default_model`
take precedence. Then trusted-project and global Worker settings apply. If none
apply, Pi receives no `--model` and uses its native default. Pi Team Bright stores
the selected exact model on Membership before launch, so recovery cannot drift.
A malformed, bare, or unavailable setting refuses the launch before carrier
creation. The refusal identifies the global or trusted-project scope; edit it and
retry. An untrusted or unknown Worker ignores project settings and can use only
the global Worker setting.

Both `agents` paths are optional and must be absolute. The four cases are:

- Neither: native global plus ancestor/project context stays unchanged.
- `append_global`: native global plus ancestor/project context, then the append file.
- `replace_global`: the replacement file, then native ancestor/project context.
- Both: the replacement file, native ancestor/project context, then the append file.

An unreadable `replace_global` warns and restores the native global contribution.
An unreadable `append_global` warns and skips only the append file. Pi Team Bright
serializes an active aggregate in a private temporary file and launches Workers
with `--no-context-files --append-system-prompt`; Pi reports appended content and
`getAgentsFiles` is empty.

### Tool-list precedence

Tool projection starts with the Worker's inherited active tool list. It then
adds registered tools named in `enable` and removes registered tools named in
`disable`. Thus, `[A, B, C]` with `enable: [E]` and `disable: [C]` becomes
`[A, B, E]`, not `[E]`. If both lists name the same tool, `disable` wins.
Unknown names are ignored with a Worker diagnostic. Settings cannot restore
leader-only tools to a Worker.

Tool projection changes only the model-visible active set. It never grants
authorization: core services, including Alert authorization, still reject
forged or prohibited calls.

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
| **Task authority** | Durable graph revisions, Task goals, assignments, Attempts, versions, outcomes, and evidence. The graph-native path uses a Team-scoped snapshot; Beads remains a legacy pre-graph fallback. |
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

- Isolate Task projection availability from valid Team and Worker carrier state
  when the underlying Beads list read is contended.
