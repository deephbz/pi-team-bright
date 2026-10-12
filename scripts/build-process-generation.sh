#!/bin/sh
# Build the optional macOS helper. Linux reads procfs directly.
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || exit 0
mkdir -p native/bin
rustc --edition=2021 -O native/process-generation.rs -o native/bin/process-generation
