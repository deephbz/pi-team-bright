#!/bin/sh
# Install the macOS generation verifier. Linux reads procfs directly.
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || exit 0
if ! command -v rustc >/dev/null 2>&1; then
  echo 'PTB warning: rustc is missing; the macOS process-generation helper was not built. Install Rust and Xcode Command Line Tools, then run npm run build:process-generation in the installed @hypercarrier/pi-team-bright directory.' >&2
  exit 0
fi
mkdir -p native/bin
if ! out=$(rustc --edition=2021 -O native/process-generation.rs -o native/bin/process-generation 2>&1); then
  echo 'PTB warning: the macOS process-generation helper failed to build. Check that Xcode Command Line Tools work (accept the Xcode license if asked), then run npm run build:process-generation in the installed @hypercarrier/pi-team-bright directory.' >&2
  printf '%s\n' "$out" | tail -n 5 >&2
  exit 0
fi
