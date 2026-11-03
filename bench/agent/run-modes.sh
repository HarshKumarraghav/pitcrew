#!/usr/bin/env bash
# Run the OpenCode agent suite through the Pit Crew gateway once per router mode.
# usage: bench/agent/run-modes.sh "C A B" [tasks]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODES="${1:-C A B}"; TASKS="${2:-A,B,C,D,E,F}"
cd "$ROOT"
for MODE in $MODES; do
  LABEL="m4-mode${MODE}-qwen35-9b"
  # Start every mode from a cold, empty backend so runs are comparable.
  for m in $(curl -s http://127.0.0.1:11434/api/ps | python3 -c 'import json,sys;print(" ".join(x["name"] for x in json.load(sys.stdin)["models"]))'); do
    curl -s http://127.0.0.1:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null
  done
  sleep 3
  PITCREW_MODE=$MODE PITCREW_LOG=normal node --experimental-strip-types --no-warnings src/cli.ts serve --config examples/pitcrew.config.json > "/tmp/gw-$LABEL.log" 2>&1 &
  GW=$!
  for i in $(seq 1 30); do curl -sf http://127.0.0.1:11500/healthz >/dev/null && break; sleep 1; done
  bench/tools/netwatch.sh "/tmp/nw-$LABEL.txt" 5400 & NW=$!
  PITCREW_OPENCODE_PROFILE="$ROOT/examples/opencode/opencode.pitcrew.json" node bench/agent/run.mjs --model pitcrew/auto --label "$LABEL" --tests "$TASKS" --timeout 900
  curl -s http://127.0.0.1:11500/governor/state > "bench/agent/results/$LABEL/gateway-state.json"
  curl -s http://127.0.0.1:11500/metrics > "bench/agent/results/$LABEL/metrics.txt"
  cp "/tmp/gw-$LABEL.log" "bench/agent/results/$LABEL/gateway.log"
  kill $NW $GW 2>/dev/null; wait $GW 2>/dev/null
  cp "/tmp/nw-$LABEL.txt" "bench/agent/results/$LABEL/netwatch.txt"
done
echo ALL-DONE
