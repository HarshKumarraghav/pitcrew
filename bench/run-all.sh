#!/usr/bin/env bash
# Full evaluation: load benchmark (direct vs governed), e2e smoke test, agent-suite repeats.
# Runs strictly one thing at a time so measurements don't disturb each other.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REPEATS="${REPEATS:-2}"
log() { echo "[$(date +%H:%M:%S)] $*"; }
unload() { for m in $(curl -s http://127.0.0.1:11434/api/ps | python3 -c 'import json,sys;print(" ".join(x["name"] for x in json.load(sys.stdin)["models"]))'); do curl -s http://127.0.0.1:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null; done; sleep 3; }

log "load benchmark"
for MODE in direct-default direct-tuned governed; do
  log "  load $MODE"
  node --experimental-strip-types --no-warnings bench/load/run.ts --mode "$MODE" --rounds 3 > "/tmp/load-$MODE.log" 2>&1
  tail -1 "/tmp/load-$MODE.log"
done

log "e2e"
bench/e2e.sh > /tmp/e2e.log 2>&1; tail -1 /tmp/e2e.log

# keep the first mode-C run: repeats would otherwise write into the same directory
[ -d bench/agent/results/m4-modeC-qwen35-9b ] && mv bench/agent/results/m4-modeC-qwen35-9b bench/agent/results/m4-modeC-qwen35-9b-r1
for r in $(seq 2 $((REPEATS + 1))); do
  log "agent repeat $r: direct baseline"
  unload
  node bench/agent/run.mjs --model local/coder --label "m1-qwen35-9b-32k-r$r" --tests A,B,C,D,E,F --timeout 900
  log "agent repeat $r: mode C"
  bench/agent/run-modes.sh "C" > /dev/null 2>&1
  mv bench/agent/results/m4-modeC-qwen35-9b "bench/agent/results/m4-modeC-qwen35-9b-r$r"
done
unload
node bench/summarize.mjs > /tmp/summary.md
log "RUN-ALL-DONE"
