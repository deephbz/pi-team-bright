# rc.14 exact-source macOS eight-Worker stress plan

Date: 2026-08-12
Status: executed for product acceptance; publication remains a separate release operation.

## Preflight result

This Worker recorded `PI_PROVIDER=openai-codex`, `PI_MODEL=gpt-5.6-terra`, and
`PI_REASONING_LEVEL=medium`. `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and
`NO_PROXY` were present. This satisfies the required Worker carrier preflight.

The isolated leader must record `openai-codex/gpt-5.6-sol` with high reasoning.
Each Worker must record `openai-codex/gpt-5.6-terra` with medium reasoning and
the same four proxy-name presence report as its first Task journal entry. Stop
and mark the run blocked if a required provider, model, or reasoning value
differs. Do not record proxy values.

## Isolation and launch

Run these commands from the intended candidate checkout. They make a new
untracked source copy, a private Pi home, and one receipt directory. They do
not start Pi or create a Team.

```sh
set -euo pipefail
ROOT="$PWD"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_ROOT="${TMPDIR:-/tmp}/ptb-rc14-e2e-$STAMP"
mkdir -p "$RUN_ROOT/source" "$RUN_ROOT/pi-home/sessions" "$RUN_ROOT/receipts"
cat >"$RUN_ROOT/pi-home/settings.json" <<'JSON'
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "high",
  "packages": [],
  "pi_team_bright": {
    "worker": {
      "default_model": "openai-codex/gpt-5.6-terra"
    }
  }
}
JSON
# Reuse credentials without reading or copying their contents. This private
# symlink stays outside the repository and every release artifact.
ln -s "$HOME/.pi/agent/auth.json" "$RUN_ROOT/pi-home/auth.json"
test ! -e "$HOME/.pi/agent/models-store.json" || \
  ln -s "$HOME/.pi/agent/models-store.json" "$RUN_ROOT/pi-home/models-store.json"
git -C "$ROOT" rev-parse HEAD | tee "$RUN_ROOT/receipts/source-head.txt"
git -C "$ROOT" diff --binary HEAD >"$RUN_ROOT/receipts/source-working.patch"
shasum -a 256 "$RUN_ROOT/receipts/source-working.patch" \
  | tee "$RUN_ROOT/receipts/source-working.patch.sha256"
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$RUN_ROOT/source"
git -C "$RUN_ROOT/source" init -q
git -C "$RUN_ROOT/source" apply "$RUN_ROOT/receipts/source-working.patch"
cd "$RUN_ROOT/source"
npm ci
EXTENSION="$RUN_ROOT/source/extensions/index.ts"
test -f "$EXTENSION"
shasum -a 256 "$EXTENSION" | tee "$RUN_ROOT/receipts/exact-extension.sha256"
# The isolated Pi home has no discovered package. The explicit worktree
# extension is its only Pi Team Bright source.
test "$(node -p "require('$RUN_ROOT/pi-home/settings.json').packages.length")" = 0
test -f "$RUN_ROOT/pi-home/settings.json"
test -L "$RUN_ROOT/pi-home/auth.json"
printf 'provider=%s\nmodel=%s\nreasoning=%s\n' "${PI_PROVIDER-}" "${PI_MODEL-}" "${PI_REASONING_LEVEL-}" \
  | tee "$RUN_ROOT/receipts/leader-carrier.txt"
for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY; do
  test -n "$(printenv "$name" || true)" || { echo "missing $name" >&2; exit 1; }
  printf '%s=present\n' "$name"
done | tee "$RUN_ROOT/receipts/leader-proxy-names.txt"
test "${PI_PROVIDER-}" = openai-codex
test "${PI_MODEL-}" = gpt-5.6-sol
test "${PI_REASONING_LEVEL-}" = high
```

Use one new Herdr tab and a named isolated Pi session. The isolated
`PI_CODING_AGENT_DIR` supplies the Worker Terra model setting and contains no
ambient Pi Team Bright package. `-ne` suppresses ambient leader extensions;
explicit `-e` loads the hashed source copy once. Keep normal Skills and project
context enabled. Start this command in the selected disposable leader pane. It
is the exact launch command.

```sh
cd "$RUN_ROOT/source"
PI_CODING_AGENT_DIR="$RUN_ROOT/pi-home" \
PI_CODING_AGENT_SESSION_DIR="$RUN_ROOT/pi-home/sessions" \
PI_MODEL_TOOL_WORKER_MODEL="openai-codex/gpt-5.6-terra" \
_codex_with_proxy pi -ne -e "$EXTENSION" --session-dir "$RUN_ROOT/pi-home/sessions" \
  --session "rc14-e2e-$STAMP" --provider openai-codex --model gpt-5.6-sol \
  --thinking high --approve
```

Before control, query `herdr agent list`, then use `herdr agent get <leader>`
and `herdr agent read <leader> --source recent-unwrapped`. Use explicit pane or
agent IDs. Do not use focus as an identity signal.

## Bounded stress protocol

Set the run limit to 20 minutes. At 15 minutes, stop new work and begin normal
Task resolution. At 20 minutes, request normal cleanup; do not kill a live
leader or a Beads child.

1. In the leader, create one Team named `rc14-e2e-$STAMP` with Worker default
   `openai-codex/gpt-5.6-terra` and medium reasoning, then create eight Workers
   named `e2e-1` through `e2e-8`. Each scope must say: record the required
   Worker preflight as a progress journal entry, then claim and close only its
   assigned probe Task with a Worker-authored result journal entry.
2. Create eight independent Tasks, one per Worker. Their acceptance text must
   require the preflight entry and the result entry. Do not create a second
   Team.
3. Use `team_sync({view:"updates"})` only for supervision. Issue 24 updates in
   three batches of eight, with five seconds between starts. Do not issue a new
   sync while the previous call lacks a result. Then issue one snapshot.
4. At least once, direct one Worker to use its exact Task version to claim and
   close its Task. This is the required Worker-authored signal, not a leader
   summary.
5. Prove recovery without a signal kill: after `e2e-1` has a terminal Task,
   ask its carrier to exit normally. The leader calls `ensure_worker` for the
   same logical Worker and scope once. The replacement must record its own
   preflight journal entry on a second assigned probe Task. A second concurrent
   ensure attempt is prohibited. This tests safe exact recovery, not carrier
   destruction.

For every `team_sync`, the leader must run these shell commands immediately
before and after the tool call. The transcript supplies the duration anchor.

```sh
python3 - <<'PY'
import time
print(f"SYNC_START_NS={time.time_ns()}")
PY
# Call exactly one team_sync({view:"updates"}) in Pi here.
python3 - <<'PY'
import time
print(f"SYNC_END_NS={time.time_ns()}")
PY
```

The receipt keeps these outer timing records as orchestration context. Sol
reasoning between the shell marker and tool call can make an outer duration
larger than the product call. Product acceptance therefore parses the raw Pi
session JSONL from each `team_sync` tool call to its matching tool result. Each
raw call must finish within 15,000 ms. A product timeout, missing result, later
result for a timed-out call, or overlapping call fails the gate. Preserve any
outer threshold miss separately; do not report model reasoning as tool latency.

## macOS diagnostic capture

Start these collectors before the first `team_sync`; stop them after the final
snapshot. Replace `LEADER_PID` with the PID from `herdr pane process-info
<leader-pane>`. These files are diagnostic evidence. They do not by themselves
prove correctness.

```sh
LEADER_PID="<leader-pid>"
export RUN_ROOT
python3 - "$LEADER_PID" "$RUN_ROOT/receipts/bd-processes.jsonl" <<'PY' &
import json, subprocess, sys, time
leader, out = sys.argv[1:]
def rows():
    text = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid=,etime=,command="], text=True)
    return [line.strip() for line in text.splitlines() if line.strip()]
while True:
    print(json.dumps({"wall_ns": time.time_ns(), "leader_pid": leader, "ps": rows()}), flush=True)
    time.sleep(.1)
PY
BD_MONITOR_PID=$!
/usr/bin/fs_usage -w -f pathname -t 1200 "$LEADER_PID" >"$RUN_ROOT/receipts/leader-fs_usage.txt" 2>&1 &
FS_USAGE_PID=$!
(
  while :; do
    /usr/bin/sample "$LEADER_PID" 1 -file "$RUN_ROOT/receipts/sample-$(date -u +%Y%m%dT%H%M%SZ).txt" || true
    sleep 5
  done
) &
SAMPLE_PID=$!
printf '%s\n' "$BD_MONITOR_PID $FS_USAGE_PID $SAMPLE_PID" >"$RUN_ROOT/receipts/collector-pids.txt"
```

After collection, calculate live `bd ... list` overlap from consecutive 100 ms
`ps` snapshots. Count a process only while its command includes both a Beads
binary name (`bd` or `beads`) and `list`. Fail if two distinct matching PIDs
occur in one snapshot during the recorded sync intervals. Keep the full JSONL.

For FSEvents, preserve all `sample-*.txt` files and `leader-fs_usage.txt`.
Fail if a sample shows repeated `FSEvent` callback stacks in a one-second
sample, or if `fs_usage` shows a sustained repeated runtime-file open/write
loop with no matching Task or event action. The reviewer must record the exact
matched lines or explicitly report no matches. This is a negative diagnostic
signal, not a claim about unobserved callbacks.

## Cleanup and receipt

Stop collectors, then use only leader tools: resolve or block every nonterminal
Task, call `worker_stop` for each current logical Worker, call one final
`team_sync({view:"updates"})`, then call `team_shutdown`. Capture every raw
result in the leader session JSONL. Do not close unrelated panes.

```sh
kill "$BD_MONITOR_PID" "$FS_USAGE_PID" "$SAMPLE_PID" 2>/dev/null || true
wait "$BD_MONITOR_PID" "$FS_USAGE_PID" "$SAMPLE_PID" 2>/dev/null || true
herdr agent list >"$RUN_ROOT/receipts/herdr-agent-list-after.txt"
herdr pane get <leader-pane> >"$RUN_ROOT/receipts/leader-pane-after.txt"
find "$RUN_ROOT/receipts" -type f -print0 | sort -z | xargs -0 shasum -a 256 \
  >"$RUN_ROOT/receipts/SHA256SUMS.txt"
```

The durable E2E receipt must name the source commit, source patch digest,
exact-extension digest, exact launch command, isolated Pi settings, absence of
an ambient Pi Team Bright package, leader and Worker provider/model/reasoning,
proxy-name presence, all Worker journal IDs,
sync outcomes and durations, the overlap result, FSEvents diagnostic result,
recovery receipt, each Worker stop receipt, Team shutdown receipt, collector
hashes, and any gate failure. It must say that terminal output and diagnostic
traces are evidence, not correctness proof.
