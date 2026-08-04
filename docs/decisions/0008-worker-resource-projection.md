# 0008 — Worker resource projection uses Pi settings

Status: accepted

A Worker may receive a local context and model-tool projection. This is a
process resource, not Team coordination state. Its sole configuration home is
`pi_team_bright.worker` in Pi global settings or trusted project settings.

[`src/utils/worker-resource-projection.ts`](../../src/utils/worker-resource-projection.ts)
reads Pi's normal global and trusted-project settings locations. Project values
have Pi's normal precedence. It never creates a package settings file and never
writes Team, Membership, Task, Session, delivery, or observation data.

`agents.replace_global` and `agents.append_global` are independent optional
absolute paths. Replacement supplies global context, ancestor/project context
follows, and append is last. A private `0700` temporary directory and atomic
`0600` aggregate file let normal Pi CLI flags compose both ordinary and trigger
turn base prompts. Pi reports it as appended content, not discovered context.
Tool enable/disable is a Worker model-facing projection, with disable winning.
The leader remains unchanged. The alerts service remains the authority.

The aggregate is made before Worker launch. It therefore applies to ordinary
and trigger-turn base prompts. On Worker reload, Pi Team Bright atomically
rewrites the fixed aggregate path from current settings and context. If both
Worker paths disappear, that rewrite serializes native global and
ancestor/project context rather than leaving stale Worker content. A final
Worker shutdown removes the disposable file on a best-effort basis. A failed
launch removes it only after no carrier exists or terminal stop is confirmed;
a possibly live carrier retains its aggregate lease. The same resolved trust
boolean controls trusted project settings and child `--approve` or
`--no-approve`. A saved trust decision for a different Worker cwd wins;
otherwise the Worker inherits the leader's resolved Pi trust. If that context
is unavailable, the always-trust environment uses `true` and `--approve`.
Settings and saved trust changes apply on Worker restart.

Malformed settings, unavailable files, and unknown tools yield at most eight
nonfatal diagnostics. They never stop orchestration. Reconsider this decision
if Pi offers a public typed custom-settings API or a public per-process resource
composition seam that preserves trusted-project context without prompt surgery.

Executable evidence is in
[`src/utils/worker-resource-projection.test.ts`](../../src/utils/worker-resource-projection.test.ts)
and
[`src/utils/worker-resource-extension.contract.test.ts`](../../src/utils/worker-resource-extension.contract.test.ts).
