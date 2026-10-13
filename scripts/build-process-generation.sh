#!/bin/sh
# Install the macOS generation verifier. Linux reads procfs directly.
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || exit 0
if ! command -v rustc >/dev/null 2>&1; then
  echo 'PTB: macOS requires Rust (rustc) and Xcode Command Line Tools to build its process-generation helper.' >&2
  echo 'Install these prerequisites, then run npm run build:process-generation in the installed @hypercarrier/pi-team-bright directory.' >&2
  exit 1
fi
mkdir -p native/bin
rustc --edition=2021 -O native/process-generation.rs -o native/bin/process-generation
