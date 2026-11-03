#!/usr/bin/env bash
# Fair baseline: OpenCode → Ollama directly, 0.8B titles with thinking off (no Pit Crew).
# usage: bench/agent/run-baseline.sh <tasks> [repeat] [label]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
TASKS="$1"; REPEAT="${2:-1}"; LABEL="${3:-baseline}"
RUN="$LABEL-r$REPEAT"
TAG="${TASKS//,/}"
for m in $(curl -s http://127.0.0.1:11434/api/ps | python3 -c 'import json,sys;print(" ".join(x["name"] for x in json.load(sys.stdin)["models"]))'); do
  curl -s http://127.0.0.1:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null
done
sleep 3
bench/tools/netwatch.sh "/tmp/nw-$RUN.txt" 21600 & NW=$!
PITCREW_OPENCODE_PROFILE="$ROOT/examples/opencode/opencode.baseline.json" node bench/agent/run.mjs --model local/coder --label "$LABEL" --repeat "$REPEAT" --tests "$TASKS" --timeout 900
kill $NW 2>/dev/null
mkdir -p "bench/agent/results/$RUN"; cp "/tmp/nw-$RUN.txt" "bench/agent/results/$RUN/netwatch-$TAG.txt" 2>/dev/null
# Leave the machine as we found it: models load with keep_alive -1.
for m in $(curl -s http://127.0.0.1:11434/api/ps | python3 -c 'import json,sys;print(" ".join(x["name"] for x in json.load(sys.stdin)["models"]))'); do
  curl -s http://127.0.0.1:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null
done
echo "DONE $RUN"
