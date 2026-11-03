#!/usr/bin/env bash
# Fair comparison on a busy machine whose state drifts (apps, Docker, swap): run task by task,
# alternating configurations, so every configuration sees the same conditions. Each task starts
# from an empty backend. Machine state is logged before every task.
#
# usage: bench/agent/interleave.sh "<tasks>" "<configs>" <repeat-from> <repeat-to>
#   configs: space-separated; "baseline" = fair baseline, anything else = bench/configs/<name>.json
#   e.g. bench/agent/interleave.sh "G H I" "baseline today" 1 1
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
TASKS="$1"; CONFIGS="$2"; FROM="$3"; TO="$4"
STATE="bench/agent/results/machine-state.log"
for r in $(seq "$FROM" "$TO"); do
  for t in $TASKS; do
    # Rotate the starting configuration per task so neither always goes first.
    set -- $CONFIGS; n=$#; i=0
    rot=$(( ( $(printf '%d' "'$t") + r ) % n ))
    ordered=()
    for c in $CONFIGS; do ordered+=("$c"); done
    for k in $(seq 0 $((n - 1))); do
      c="${ordered[$(( (k + rot) % n ))]}"
      echo "$(date +%FT%T) r$r $t $c swap=$(sysctl -n vm.swapusage | awk '{print $6}') pressure=$(sysctl -n kern.memorystatus_vm_pressure_level) docker=$(pgrep -q com.docker.backend && echo on || echo off) free=$(memory_pressure -Q | awk '/percentage/{print $NF}')" >> "$STATE"
      if [ "$c" = baseline ]; then bench/agent/run-baseline.sh "$t" "$r" baseline
      else bench/agent/run-pitcrew.sh "pitcrew-$c" "bench/configs/$c.json" "$t" "$r"; fi
    done
  done
done
echo "INTERLEAVE-DONE"
