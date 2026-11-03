#!/usr/bin/env bash
# Claude Code (cloud models) on the same six tasks, same fixture, same hidden verifiers.
# Uses the logged-in Claude Code account; no permission bypass (allowlist + dontAsk).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
RUNS="${RUNS:-3}"
for r in $(seq 1 "$RUNS"); do
  for m in claude-opus-4-6 claude-sonnet-4-6; do
    echo "[$(date +%H:%M:%S)] claude code $m run $r"
    node bench/agent/run.mjs --agent claude --model "$m" --label "cc-${m#claude-}-r$r" --tests A,B,C,D,E,F --timeout 900
  done
done
node bench/summarize.mjs > /tmp/summary.md
echo CLAUDE-DONE
