# Removed-Task replacement real canary result

Date: 2026-08-13
Source commit: `6647c9bc14178d354c1e52528ed91b72079da3ee`
Task: `ptb-graph-native-next-pxb`

## Result

The source repair passed typecheck and focused deterministic verification, but
the first real Team canary did not reach graph replacement. A Worker carrier
started, but its model authentication refresh failed before any Worker-authored
Task event. The canary therefore gives no runtime evidence for removed-Task
replacement. It gives exact evidence for a pre-graph infrastructure blocker.

## Exact-source and proxy proof

An isolated Pi coordinator started through `_codex_with_proxy` with
`openai-codex/gpt-5.6-terra:medium`, `packages: []`, and the extension at this
worktree. Its child check proved `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`
were present without printing their values. It reported branch
`feature/dag-native-rc13`, exact source
`6647c9bc14178d354c1e52528ed91b72079da3ee`, the required model, and a visible
`task_graph_apply` tool.

## Real Team evidence

The coordinator created Team `graph-replacement-canary-20260813` and Worker
`builder`. `ensure_worker` returned `worker_ensured` with a connected carrier.

Graph apply operation `canary-bootstrap-apply-001` committed one ready Task:

- graph version: `g_4fb1cfcb08aa314d`;
- Task: `bootstrap`;
- Task version before cleanup: `v_a6cf077c5c09dffa`.

A snapshot returned one Worker and one Task. Repeated update waits returned
`indeterminate` because Worker run-state evidence was incomplete. Direct Herdr
diagnosis then showed the exact Worker pane failing during model authentication
token refresh. No Worker-authored Task mutation occurred, so launch was not
proven and the replacement scenario did not start.

## Cleanup

The coordinator used normal Team tools only. It cancelled `bootstrap` with
operation `canary-bootstrap-cancel-auth-failure-001` and evidence:

`Worker carrier authentication failed before launch proof.`

The cancellation produced Task version `v_9877afffc675ad3a`. `worker_stop`
returned `worker_stopped` for `builder`. `team_shutdown` returned lifecycle
`stopped` with no unfinished Tasks. The isolated coordinator pane was then
closed. No fallback Session, storage edit, push, tag, or publication occurred.

## Verification already passed

Before this canary:

- `npm run typecheck` passed;
- seven new replacement and Coordination tests passed;
- 32 focused tests passed across replacement, Coordination, graph integration
  smoke, Task delivery, and legacy event hydration.

## Supported-authentication retry

A second isolated coordinator started through the same proxy contract at exact
HEAD `4c1ba246831938b723c3f43e3ae3832a0911dd37`. Preflight proved the proxy
variables, provider `openai-codex`, model ID `gpt-5.6-terra`, reasoning level
`medium`, exact branch and commit, and visible `task_graph_apply`.

It created Team `graph-replacement-canary-retry-20260813` and stable Worker
`builder`. Bootstrap operation `canary-bootstrap-20260813-001` committed graph
`g_833ddcfb2bd4f38d` and ready Task version `v_d8d957c9edf7ff39`. The required
snapshot returned one Worker and one Task. The first event-driven update again
returned `indeterminate`, with no observation published. Exact Herdr diagnosis
again showed the Worker failing during model authentication token refresh. No
Worker-authored Task event occurred. Per the launch gate, no replacement,
replay, removed delivery, or current-Task assertion ran.

Cleanup used normal tools. Cancel operation
`canary-bootstrap-cancel-auth-retry-20260813-001` used evidence `Worker model
authentication token refresh failed before launch proof.` and produced Task
version `v_57a8820fab3d479b`. `worker_stop` returned `worker_stopped` for
`builder`. `team_shutdown` returned no unfinished Task IDs. The coordinator pane
was closed. No fallback Session or storage edit occurred.

## Next action

The retry proves this is not an extension-source or proxy-preflight mismatch.
Repair the stored model-authentication refresh path used by new Workers. The
operator must renew or replace the credential through the supported login flow;
agents must not inspect or edit credential storage. Then rerun the same
exact-source real scenario. Do not claim runtime replacement acceptance until a
Worker-authored bootstrap event proves launch and the replacement, `team_sync`,
removed `task_read`, replay repair, and current-Task evidence all complete.
