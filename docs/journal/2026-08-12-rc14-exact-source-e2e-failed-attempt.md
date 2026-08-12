# rc.14 exact-source E2E failed launch receipt

Date: 2026-08-12
Stage: hardening
Result: launch gate failed; Team shutdown completed

## Source and launch

The leader used `openai-codex/gpt-5.6-sol` with high reasoning. The configured Worker model was `openai-codex/gpt-5.6-terra` with medium reasoning. The leader verified name presence for `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`. No proxy values were recorded.

Source HEAD was `53367e412ad0217bfcf4845d92a07bb9ebec6de2`. The pre-run binary working-tree diff digest was `e420bd61c008de5265e86422270619b06dac48cb0950561534f0b93370d94180` with SHA-256.

The exact launch command was:

```sh
cd "$REPOSITORY" && PI_MODEL_TOOL_WORKER_MODEL=openai-codex/gpt-5.6-terra _codex_with_proxy pi -ne -e "$REPOSITORY/extensions/index.ts" --model openai-codex/gpt-5.6-sol --thinking high --approve --name rc14-exact-source-e2e-leader
```

## Failure and reconciliation

Team `rc14-exact-source-e2e` was created. All eight logical Worker names, `e2e-1` through `e2e-8`, received prepared Membership attempts. Each launch failed and compensation deactivated the exact prepared Membership.

The full `e2e-1` failure was:

```text
Failed to launch e2e-1: Herdr command failed with status 1: {"error":{"code":"agent_name_not_found","message":"named agent e2e-1 no longer owns the target terminal"},"id":"cli:agent:start"}
. The exact prepared Membership was deactivated after compensation.
```

The owner identified the cause as ambient duplicate installation discovery. The Worker command loaded the worktree extension with explicit `-e`, but shared Pi settings also discovered another `pi-team-bright` copy. A clean disposable Herdr pane started Terra-medium Pi successfully, so this attempt does not prove a Herdr adapter defect.

Eight independent probe Tasks were created, but no Worker authored a Task event. The leader blocked all eight with failed-launch evidence. `team_shutdown` returned lifecycle `stopped`, `stopped_workers: []`, and retained the eight blocked Task IDs as `unfinished_task_ids`. All prepared Worker Memberships were already inactive after compensation.

## Sync and proof limits

The machine receipt is `/tmp/rc14-exact-source-sync-durations.jsonl`. Four non-overlapping sync calls completed in 11,197.836 ms, 14,483.567 ms, 13,929.657 ms, and 16,148.313 ms. The fourth call exceeded the 15-second gate. One bounded source-search command also timed out at 15 seconds and stopped without mutation.

This failed attempt did not complete 25 sync calls, Worker probes, safe recovery, exact Worker stops, or Worker model evidence. It did not run the reserved aggregate. It did not commit, tag, push, or publish. Team and Task records are historical evidence, not proof that the intended E2E passed.
