# Warm activation prototype continuation

Date: 2026-08-14
Status: implementation not yet started; plan artifacts exist.
Scope: only the assigned isolated worktree.

## Task authority and coordination

Task `ptb-worker-startup-opt-10o` remains assigned and ready at version
`v_7ed2b2dbc5e6f20f`. The required Worker `claim` was attempted twice with
operation ID `claim-warm-activation-prototype`. Both attempts refused:
`Legacy Task mutation is disabled on the graph-native Worker surface; apply a
graph revision first.` The Worker tool surface has no graph-revision tool.

The lead confirmed a mixed coordinator/Worker version prevents the claim. The
Task remains the executable contract. Continue the experiment and send one
result Alert with commit and evidence. The lead will reconcile Task authority.

## Durable planning completed

- `docs/journal/2026-08-14-warm-activation-prototype-plan.md` is the problem,
  prediction, method, safety, and interpretation plan.
- `benchmarks/warm-activation/plan.json` is the machine-readable idea/data
  graph.

The main predictions are: RPC Session replacement is faster but has fixed
launch role/cwd/resources; SDK replacement is faster but can retain
process-scoped extension state; a reserved Herdr pane is fast but cannot become
an exact Worker without a new process and startup admission.

## Evidence already inspected

The package is in hardening but this experiment is exploration. The current
Worker contracts distinguish logical Worker, Membership, exact Pi Session,
process generation, terminal carrier, and Task authority.

`WorkerLaunchBridge` creates the Membership and aggregate before spawning,
passes `PI_TEAM_NAME`, `PI_AGENT_NAME`, `PI_TEAM_MEMBERSHIP_ID`, and launch ID,
and only the child does runtime claim and Session bind. `TeamSessionLifecycleService`
fences one live process generation per current Membership. Worker resource
projection materializes a fixed CLI aggregate and projections occur before
startup. The Pi adapter projects Worker tools only after startup identity;
unbound normal extension startup otherwise has the leader surface.

Pi SDK documentation and installed local 0.83.0 types show that
`AgentSessionRuntime.newSession()` replaces the active Session and callers must
rebind Session-local subscriptions/extensions. Pi RPC supports `new_session`,
`abort_bash`, `get_state`, and strict LF JSONL.

`HERDR_ENV=1` was confirmed. Herdr was queried in the required order:
`agent list`, this Worker's `agent get`, `agent read --source recent-unwrapped`,
then exact pane and process inspection. This Worker owns pane `w4:p1ET`.
Herdr help confirms `pane split --no-focus`, `agent start <name> --kind pi
--pane <id> -- --args`, `agent prompt`, and `pane close`.

The local assigned worktree initially had no `node_modules`. `npm ci` correctly
refused because package-lock is out of sync with package.json. In the assigned
worktree, `npm install --package-lock=false --ignore-scripts --no-audit --no-fund`
installed dependencies without tracked changes. Local Pi SDK and CLI are
0.83.0. Do not update the lockfile for this experiment.

One accidental earlier dependency-install attempt ran from the primary checkout
because its command lacked `cd`; it used `--package-lock=false`, and no tracked
change was observed. Do not touch or clean the primary checkout.

## Required implementation next

Create isolated disposable source under `benchmarks/warm-activation/`:

1. A probe extension writes safe JSON records on `session_start`,
   `session_shutdown`, and a slash command. Record only fixture labels and
   booleans for extension/resource/cwd/model, Session ID/file change, process
   PID, selected tool surface, Team environment presence, and module/factory
   state. Never record credentials, home paths, prompts, or provider payloads.
2. A TypeScript runner launches the package-local 0.83.0 RPC CLI in a temporary
   Pi home and project cwd. Measure cold spawn-to-`get_state`; then repeated
   `new_session` request-to-response, using a changed safe AGENTS marker to
   check resource reload. Probe `abort_bash`, SIGKILL/restart recovery, and
   graceful shutdown. Include a one-off exact Pi Team Bright extension plus
   probe run to show the pre-binding leader/Worker tool surface.
3. The same runner creates an SDK `AgentSessionRuntime` with a controlled
   resource loader and measures initial construction versus `newSession()`.
   Test fresh Session IDs, extension rebind/session shutdown, context-marker
   reload, and module/closure state retention.
4. If safe, split only this Worker's exact Herdr pane with `--no-focus`, start a
   uniquely named no-Task probe Pi carrier, then invoke its slash command with
   `agent prompt`. Use its artifact, then query exact agent/pane state and close
   only the created pane. Measure split/start cold and command warm activation.
   Do not infer a Membership, readiness, or Task authority from it.
5. Add the lead's requested falsifiable fourth mechanism: a fresh reserved Node
   process imports Pi's main/module graph before activation, waits without
   creating a Pi Session, then receives exact env/cwd/profile and invokes Pi
   main. Measure import-to-activation; determine main export/reentrancy,
   Session behavior, PTY/pane need, Herdr naming/observation, and whether
   Worker admission remains checked. It is disposable only.
6. Write raw machine JSON and derived p50/p95 JSON/Markdown under
   `docs/journal/artifacts/`, with environment versions, source commit,
   parameters, individual samples, failures, cleanup, and limits. Commit only
   source and redacted results. No push, tag, or publication.

Use nearest-rank p50/p95 on successful samples and report failures separately.
A fast command inside a pane is not a Worker activation success.

## Implementation update

The disposable runner now exists under `benchmarks/warm-activation/` with a
probe extension, an RPC/SDK/Herdr benchmark, a one-shot preloaded-main child,
and a Bun-built inline Pi Team Bright factory path. It uses private temporary
homes, projects, Session directories, and raw probe files. It records only
redacted derived records in the durable JSON artifact.

Focused smoke runs passed all five paths with three samples each. They showed
that RPC and SDK `newSession()` retain the process and the probe module while
replacing Session identity and reloading the fixture context marker. The
inline preloaded Pi Team Bright factory selected leader-only tools in an
unbound process. The pane command was fast but remained an unbound carrier;
Herdr named and observed it, and the probe sent a graceful shutdown before the
runner closed its exact child pane.

The remaining work is to run the final seven-sample machine measurement, write
the result interpretation, update current context if needed, and commit the
source and durable result artifacts. No exact Worker Membership admission was
attempted because this experiment never creates a prepared Membership. RPC
Session readiness remains distinct from Worker readiness.

## Final measurement update

The final seven-sample run completed from source commit
`8324307dadf7107494d0485a6974bd192454fbac`. It passed every requested
mechanism and closed every child pane. The durable raw timing and invariant
artifact is `2026-08-14-warm-activation-machine-results.json`. The derived
assessment and ranked no-production decision are in
`2026-08-14-warm-activation-prototype-result.md`.
