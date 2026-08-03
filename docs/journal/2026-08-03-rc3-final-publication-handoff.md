# Pi Team Bright rc.3 final publication handoff

Date: 2026-08-03

## Current result

The owner authorized end-to-end delivery and npm publication of `0.17.0-rc.3`.
The owner restarted the coordinating Session and closed its teammates, so
continuation is solo from the current working tree.

Current repository state observed immediately before this handoff:

- branch: `main`
- HEAD: `54016c82730744125c2d492a6f53313acabb806f`
- working tree: dirty with the complete intended rc.3 source bundle
- package, lockfile root, `pi.image`, and model-tool implementation fence: `0.17.0-rc.3`
- npm registry before publication: `next=0.17.0-rc.2`, `latest=0.17.0-rc.1`
- privacy configuration: `privacy.public=true`; baseline
  `d858d9f81261f5c2bfbe9e1eaf342b523e0114eb`

Do not reset or discard the working tree.

## Accepted implementation

The rc.3 tree includes these accepted changes:

- exact 2,000-character candidate Task `current_context` validation before
  Beads mutation, canonical invalid-metadata contract gaps, and safe sync/read
  behavior;
- production ten-tool model surface without preview names or prompt-injected
  leader/standalone tool instructions;
- role-specific Worker Task/Alert tools, exact leader Alert targeting, public
  opaque `v_...` Task versions, and verified conversion to raw Beads CAS only
  at the mutation boundary;
- required per-item `task_create.operation_id`, same-operation replay,
  operation-conflict refusal, unknown-outcome recovery, and one Task row, one
  Task event, and one delivery across replay;
- semantic-result totality repairs for create/update model and TUI projections;
- normal unrelated extension and Skill discovery with exact working-tree `-e`;
  no blanket `-ne` or `-ns` suppression;
- Pi 0.83 support while retaining the tested 0.80.10 and 0.82.x lines;
- exact Team pane placement for Herdr and tmux: leader left at least 60%, later
  Workers split only the right Worker region, no whole-window relayout, and
  exact Worker close;
- `pi_team_bright.worker.default_model` in active Pi settings, with global and
  trusted-project precedence, exact Membership persistence, pre-carrier
  refusal for invalid explicit settings, and nested Pi IDs such as
  `openrouter/openai/gpt-5.1`;
- restored established Pi/proxy environment allowlist; production source
  contains no proxy address;
- refreshed contract HTML, QA projection, agent-surface snapshot, release
  metadata, and sanitized journal evidence.

Architecture contract changed at existing model-tool, Task/Beads/event, Worker
launch/settings, and terminal-adapter boundaries. No depicted component,
dependency, authority, store, trust boundary, deployment topology, or data flow
changed, so the Structurizr topology remained unchanged.

## Real lifecycle evidence

Durable evidence is under `docs/journal/artifacts/`:

- `2026-08-03-final-pi083-herdr-layout-gate.json`
- `2026-08-03-pi083-worker-settings-version-ref-smoke.json`
- `2026-08-03-pi083-worker-override-gate.json`
- `2026-08-03-pi-083-herdr-normal-composition.json`
- earlier diagnostic artifacts retained as historical evidence

The combined Pi 0.83/Herdr evidence proved:

- semantic create, identical replay, and changed-input conflict behavior;
- two exact Worker Membership-to-Session bindings;
- leader remained left at exactly 60% after two Workers and after first stop;
- later Worker split only the right region;
- exact Worker stop and Team shutdown touched only disposable panes;
- unrelated extension and Skill discovery remained available.

The configured OpenRouter GPT-5.1 Workers reached exact Session binding but the
provider returned an external 403 Terms-of-Service response before tool calls.
The operator's real global setting remains `openrouter/openai/gpt-5.1`. A final
disposable settings smoke used authorized
`openai-codex/gpt-5.6-terra` without changing that global preference. It proved
first-attempt `task_update` with the public `v_...` ref, a second update with the
new ref, no normal version conflict, Membership model persistence, Worker stop,
and Team shutdown.

## Test evidence

The first aggregate run exposed two focused failures. Both were repaired:

- stale E2E evaluator calls now convert raw test receipt versions to public
  `v_...` refs before Worker claims;
- the real-Beads Worker version test has a measured and justified 120-second
  local bound instead of the aggregate-contention-sensitive 60-second bound;
- task-surface test temporary roots are removed in cleanup.

Independent two-file verification passed with 5 tests, typecheck, diff check,
and no new temporary residue.

The replacement final aggregate run passed and must not be repeated locally:

```text
TERM_PROGRAM=iTerm.app npm run test:full
Test Files 69 passed (69)
Tests      542 passed (542)
Duration   276.31s
```

`node scripts/verify-test-lanes.cjs` had already passed with 69 files: 51 fast
and 18 exhaustive.

## Package gate progress

The interrupted release verifier completed a fresh dry-run manifest and pack:

- package: `@hypercarrier/pi-team-bright@0.17.0-rc.3`
- filename: `hypercarrier-pi-team-bright-0.17.0-rc.3.tgz`
- entries: 75
- compressed size: 209,834 bytes
- unpacked size: 920,986 bytes
- npm shasum: `12c9748e7a48f240072311ec5b77cd93e88997ab`
- npm integrity:
  `sha512-r8lWWk+QqJJm7caIFmLfNVKUnfAQqOy14ErkU0gBqWUefDyorzNTRqosAv+bl4mczh2F1JlSemOirJix51ctuw==`
- local tarball SHA-512 hex:
  `afc9565a4f90a89266edc6881662df3552949df010a8ecb5e04ae4534801a9651e7c3ca8af335346aa2c02ff9b97899cce1d85d499527a63a2ac98b1e7572dbb`

The isolated npm install began, but its combined 900-second command timed out
while running the Pi extension canary. The subsequent privacy commands in that
combined command did not produce success evidence. A provider WebSocket idle
timeout also interrupted the verifier Session. Do not rerun the full suite;
resume only the unfinished package, clean-install/canary, diff, and privacy
gates.

Local authenticated npm fallback is unavailable because `npm-auth` could not
find its keychain entry. Publication must use the repository GitHub Actions
OIDC/provenance workflow.

## Exact continuation

1. Inspect the current diff and status after compaction. Preserve all intended
   changes. Confirm no unexpected commit or user change occurred around HEAD
   `54016c8273...`.
2. Run only unfinished fast/release gates. Do not rerun `test:full`:
   - required QA commands;
   - `verify:package`;
   - fresh package-content comparison only if the tree changed after the
     recorded pack;
   - isolated install and Pi canary as separate bounded commands so a canary
     timeout does not erase install evidence;
   - `git diff --check`.
3. Scan staged/current content for private paths and secrets. The package author
   is pre-existing owner-approved public metadata. Never print a detected
   private value.
4. Commit the complete rc.3 source bundle with the approved public identity
   `deephbz` and its GitHub noreply email through the normal privacy hooks.
   Confirm a clean tree.
5. Run the mandatory final publication privacy gate on the release commit:
   `git-privacy-scan --ref <release-commit> history`. Keep its receipt outside
   the repository and do not print detected values.
6. Push `main`. Create and push annotated tag `v0.17.0-rc.3` on the same exact
   commit because `pi.image` references that tag. Confirm repository release
   policy before choosing whether the tag precedes a dry-run workflow.
7. Use `.github/workflows/publish.yml` with GitHub OIDC. The workflow itself
   runs mandatory aggregate tests. Do not add another local full run. Dispatch
   the required dry run only if repository policy requires it, then dispatch
   publication on the exact tag/SHA with `dry_run=false`, `tag=next`, and a
   unique nonce.
8. Verify workflow success, exact SHA, npm `0.17.0-rc.3`, `next`, tarball,
   shasum/integrity, provenance, and GitHub tag/release evidence. Write a
   durable release receipt.
9. If the old Team still exists after the owner closed its teammates, reconcile
   only terminal Tasks and shut it down. Do not recreate teammates for normal
   continuation.

Do not publish from a dirty tree. Do not use local npm publication. Do not
remove the operator's global GPT-5.1 Worker preference because its external 403
is an account/TOS issue, not a package defect.
