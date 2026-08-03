# Isolated model-tool canary

This private harness runs the unregistered candidate journey through one real
provider-bound Pi Session. It proves one in-process logical Team, Worker, and
assigned Task observation. It does not prove carrier readiness, Task execution,
persistence, public registration, or production readiness.

The runner requires package-local Pi 0.80.10 and an explicit provider, model,
and provider credential environment variable. It creates a fresh working
folder, Pi config folder, and Session folder inside the operator-selected raw
bundle. The raw bundle must be a new absolute path outside this Git repository.
Files use mode 0600 and the bundle folder uses mode 0700.

The accepted canary uses OpenAI Codex Luna. Acquire the bearer token without
printing it, then remove the shell variable after the run:

```sh
token="$(pi auth print-bearer-token \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --min-expiry 10m)"
OPENAI_CODEX_OAUTH_TOKEN="$token" \
  node scripts/model-tool-canary/run.mjs \
    --provider openai-codex \
    --model gpt-5.6-luna \
    --credential-env OPENAI_CODEX_OAUTH_TOKEN \
    --thinking off \
    --raw-dir "$(mktemp -d)/raw-evidence" \
    --receipt docs/journal/artifacts/model-tool-real-pi-canary.json
unset token
```

The runner invokes Pi with RPC mode, offline startup, no discovered extensions,
skills, prompt templates, themes, context files, project trust, or built-in
tools. It explicitly loads only `extension.ts` and enables only `team_create`,
`ensure_worker`, `task_create`, `task_read`, `task_update`, and `team_sync`.

Exit 0 means all isolation, provider-schema, Session, call-order, semantic
result, negative-boundary, capture, and process checks passed. Exit 1 means the
run completed with failed checks. Exit 2 means the harness could not run. Raw
provider payloads, RPC JSONL, Session JSONL, stderr, identifiers, and model text
stay in the private bundle. Commit only the generated redacted receipt.
