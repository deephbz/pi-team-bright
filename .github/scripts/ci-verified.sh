#!/usr/bin/env bash
# Content-addressed CI result: a tree that passed every CI job is recorded as
# the artifact ci-verified-<git tree hash>. Re-running CI for the same tree (the
# push after merging an up-to-date PR, or a release tag) then skips all work.
#   lookup  - print verified=true|false to $GITHUB_OUTPUT
#   name    - print the artifact name for HEAD
set -euo pipefail
name="ci-verified-$(git rev-parse 'HEAD^{tree}')"
case "${1:-}" in
  name) echo "$name" ;;
  lookup)
    # Trust only unexpired records produced by runs of this repository's own
    # branches, not by fork pull requests that could have edited the workflow.
    count="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=$name&per_page=100" \
      --jq '[.artifacts[] | select(.expired | not) | select(.workflow_run.head_repository_id == .workflow_run.repository_id)] | length')" \
      || count=0  # A failed lookup runs the full CI rather than failing it.
    if [ "$count" -gt 0 ]; then
      echo "::notice::$name already passed CI; skipping."
      echo "verified=true" >> "$GITHUB_OUTPUT"
    else
      echo "verified=false" >> "$GITHUB_OUTPUT"
    fi
    ;;
  *) echo "usage: $0 lookup|name" >&2; exit 2 ;;
esac
