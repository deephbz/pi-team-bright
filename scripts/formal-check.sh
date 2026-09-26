#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
model_dir="$source_dir/formal"
expected_sha=ab4694601923fd5ac06452abbf847c366a5054a3d739552085edd6ed986c29ec
jar=${TLA2TOOLS_JAR:-}
if [[ -z "$jar" || ! -f "$jar" ]]; then
  echo "Set TLA2TOOLS_JAR to the pinned TLC jar path." >&2
  exit 2
fi
jar=$(cd "$(dirname "$jar")" && pwd)/$(basename "$jar")
actual_sha=$(shasum -a 256 "$jar" | awk '{print $1}')
if [[ "$actual_sha" != "$expected_sha" ]]; then
  echo "TLC jar checksum mismatch: expected $expected_sha, got $actual_sha" >&2
  exit 2
fi
if ! command -v java >/dev/null; then
  echo "Java is required for TLC." >&2
  exit 2
fi

result_dir=${FORMAL_RESULTS_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/pi-team-bright-formal.XXXXXX")}
mkdir -p "$result_dir"
result_dir=$(cd "$result_dir" && pwd)

run_case() {
  local model=$1 config=$2 expected=$3 case_dir="$result_dir/$2" code=0
  mkdir -p "$case_dir"
  (
    cd "$case_dir"
    java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -deadlock -noGenerateSpecTE \
      -metadir "$case_dir/states" -config "$model_dir/$config.cfg" \
      "$model_dir/$model.tla"
  ) >"$case_dir/tlc.log" 2>&1 || code=$?
  if [[ "$expected" == pass ]]; then
    if [[ "$code" -ne 0 ]] || ! grep -q 'Model checking completed. No error has been found.' "$case_dir/tlc.log" || ! grep -q '0 states left on queue' "$case_dir/tlc.log"; then
      echo "FAIL $config: expected complete search; see $case_dir/tlc.log" >&2
      return 1
    fi
  else
    if [[ "$code" -eq 0 ]] || ! grep -q "Invariant $expected is violated" "$case_dir/tlc.log"; then
      echo "FAIL $config: expected $expected counterexample; see $case_dir/tlc.log" >&2
      return 1
    fi
  fi
  echo "OK $config: $(grep -E 'states generated|depth of the complete state graph search' "$case_dir/tlc.log" | tr '\n' ' ')"
}

run_case GraphAttempt GraphAttempt pass
run_case GraphAttempt GraphAttempt.mutant AcceptedLineage
run_case GraphAttempt GraphAttempt.repair-bound RepairBound
run_case GraphAttempt GraphAttempt.interleave NoRevisionRepairInterleave
run_case MembershipFence MembershipFence pass
run_case MembershipFence MembershipFence.mutant LeaseExact
run_case MembershipFence MembershipFence.stale-write NoStaleWrite
run_case PublicationObservation PublicationObservation pass
run_case PublicationObservation PublicationObservation.early-publication CommitBeforePublication
run_case PublicationObservation PublicationObservation.partial-observation CompleteBeforeAdvance
run_case PublicationObservation PublicationObservation.trust-fence CurrentDeliveryOnly
run_case PublicationObservation PublicationObservation.skip-replay TruthfulReplay
run_case PublicationObservation PublicationObservation.retry-retirement NoStaleRetirement
run_case PublicationObservation PublicationObservation.crash-replay NoCrashReplayWitness
run_case PublicationObservation PublicationObservation.retirement-gap NoRetirementGapWitness
echo "TLC logs: $result_dir"
