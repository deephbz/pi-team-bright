# Worker authentication recovery result

Date: 2026-08-13
Task: `ptb-graph-native-next-2co`
Source: `4bec21778cdbb26b8349f9395e35915604299d1b`

## Result

The repeated Worker failure came from the isolated launch configuration, not
the selected OpenAI Codex credential. The failed isolated settings removed all
default model settings. Pi Team Bright therefore created Workers without a
`--model` argument, and Pi selected its ambient/default Anthropic provider.
That unrelated stored Anthropic OAuth refresh failed. The coordinator itself
worked because its command explicitly selected Terra.

Restoring the prior successful non-secret model defaults fixed the launch. A
fresh real Worker used the captured model `openai-codex/gpt-5.6-terra` and
published Worker-authored Task events through the exact integrated extension.
No credential content was read, printed, copied, or edited.

## Diagnostic evidence

The normal proxy one-shot succeeded with explicit
`openai-codex/gpt-5.6-terra:medium`. Explicit Terra one-shots also succeeded in
both failed isolated roots. An implicit one-shot in either failed root selected
Anthropic and failed its token refresh.

The prior successful graph E2E root had these non-secret settings:

- default provider `openai-codex`;
- default model `gpt-5.6-terra`;
- default thinking level `medium`;
- Pi Team Bright Worker default model `openai-codex/gpt-5.6-terra`;
- packages disabled for exact-source isolation.

The failed roots had only `packages: []`. Their auth files were symbolic links
to the normal Pi auth file with mode `0600` at the target. Their credential
location and permissions were not the defect.

A repaired isolated root restored the settings above and linked the normal auth
and model-catalog files. Its implicit proxy one-shot succeeded.

## Real Worker proof

The repaired exact-source coordinator proved the proxy variables, branch,
commit, provider, model, reasoning level, and visible `task_graph_apply`. It
created Team `graph-auth-recovery-20260813` and Worker `builder` without an
explicit per-Worker model override.

Bootstrap operation `auth-recovery-bootstrap-20260813` committed graph
`g_ce592a36d8edec13`. Task versions were:

- ready: `v_5676a2f8aa9e3ced`;
- claimed: `v_d9efd84cca76fc8b`;
- goal achieved: `v_d642c16bf1c4cedb`.

`team_sync` first returned the required snapshot. A transient `indeterminate`
result did not advance observation. The next updates contained Worker-authored
`in_progress` and `goal_achieved` Task changes. The Worker recorded result
evidence exactly `supported auth worker launch proof`.

The durable Membership captured model `openai-codex/gpt-5.6-terra`. The graph
Attempt trace used `current-worker-model` because the coordinator process did
not set `PI_TEAM_BRIGHT_MODEL_DEFAULT`; this is a separate graph-alias label and
does not change the proven Worker carrier model.

Cleanup stopped `builder` and shut down the Team with no unfinished Task IDs.
The coordinator pane was closed. No fallback Session, credential mutation,
storage repair, push, tag, or publication occurred.

## Durable lesson

Exact-source isolation must retain both parts of the launch contract:

1. disable ambient packages and load the exact extension explicitly;
2. set the coordinator and Worker default model policy explicitly.

An explicit coordinator `--model` does not automatically set a Team or Worker
model. For this canary class, include `pi_team_bright.worker.default_model` or
an explicit Team default when the Task contract requires Terra Workers.
