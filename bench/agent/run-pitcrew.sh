#!/usr/bin/env bash
# One OpenCode agent run through a Pit Crew gateway started with the given config.
# usage: bench/agent/run-pitcrew.sh <label> <config.json> <tasks> [repeat]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
LABEL="$1"; CONFIG="$2"; TASKS="$3"; REPEAT="${4:-1}"
RUN="$LABEL-r$REPEAT"
TAG="${TASKS//,/}"
# Cold, empty backend so runs are comparable.
for m in $(curl -s http://127.0.0.1:11434/api/ps | python3 -c 'import json,sys;print(" ".join(x["name"] for x in json.load(sys.stdin)["models"]))'); do
  curl -s http://127.0.0.1:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null
done
sleep 3
PITCREW_LOG=normal node --experimental-strip-types --no-warnings src/cli.ts serve --config "$CONFIG" > "/tmp/gw-$RUN.log" 2>&1 &
GW=$!
for i in $(seq 1 30); do curl -sf http://127.0.0.1:11500/healthz >/dev/null && break; sleep 1; done
bench/tools/netwatch.sh "/tmp/nw-$RUN.txt" 21600 & NW=$!
# A config may ask for best-of-N (`pitcrew solve`) via a top-level "benchAttempts" (the gateway ignores it).
ATTEMPTS=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("benchAttempts",1))' "$CONFIG")
PITCREW_OPENCODE_PROFILE="$ROOT/examples/opencode/opencode.pitcrew.json" node bench/agent/run.mjs --model pitcrew/auto --label "$LABEL" --repeat "$REPEAT" --tests "$TASKS" --timeout 900 --attempts "$ATTEMPTS"
mkdir -p "bench/agent/results/$RUN"
curl -s http://127.0.0.1:11500/governor/state > "bench/agent/results/$RUN/gateway-state-$TAG.json"
cp "$CONFIG" "bench/agent/results/$RUN/gateway-config.json"
cp "/tmp/gw-$RUN.log" "bench/agent/results/$RUN/gateway-$TAG.log"
kill $NW $GW 2>/dev/null; wait $GW 2>/dev/null
cp "/tmp/nw-$RUN.txt" "bench/agent/results/$RUN/netwatch-$TAG.txt" 2>/dev/null
# Leave the machine as we found it: models load with keep_alive -1.
for m in $(curl -s http://127.0.0.1:11434/api/ps | python3 -c 'import json,sys;print(" ".join(x["name"] for x in json.load(sys.stdin)["models"]))'); do
  curl -s http://127.0.0.1:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null
done
echo "DONE $RUN"
