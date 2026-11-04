#!/usr/bin/env bash
# End-to-end check of every Pit Crew command and endpoint against the real local Ollama.
# Needs: ollama running with qwen3.5:9b and qwen3.5:0.8b pulled. Prints a PASS/FAIL table.
# usage: bench/e2e.sh [port]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-11500}"; GW="http://127.0.0.1:$PORT"
cd "$ROOT"
PC=(node --experimental-strip-types --no-warnings src/cli.ts)
pass=0; fail=0; rows=()
check() { # name, command...
  local name="$1"; shift
  local t0=$(date +%s)
  if out=$("$@" 2>&1); then rows+=("PASS  $(printf '%-46s' "$name") $(( $(date +%s)-t0 ))s"); pass=$((pass+1));
  else rows+=("FAIL  $(printf '%-46s' "$name") $(( $(date +%s)-t0 ))s  ${out:0:160}"); fail=$((fail+1)); fi
}
has() { grep -q -- "$1"; }
post() { curl -s -m 600 "$GW$1" -H 'content-type: application/json' -d "$2"; }

check "npm test (unit+integration, mock backend)" bash -c "npm test 2>&1 | grep -q '^# fail 0'"
check "typecheck" npx tsc -p tsconfig.json --noEmit
check "build + dist CLI help" bash -c "npm run -s build && node dist/cli.js --help | grep -q 'pitcrew'"
check "audit sees machine + models" bash -c "${PC[*]} audit | grep -q 'qwen3.5:9b'"
check "garage lists footprints" bash -c "${PC[*]} garage | grep -q 'qwen3.5:0.8b'"
check "scout writes 6 artifacts outside repo" bash -c "${PC[*]} scout bench/agent/fixture | grep -q 'DEPENDENCY_GRAPH.json' && test ! -e bench/agent/fixture/PRODUCT_OVERVIEW.md"
check "context ranks slugify for slugify bug" bash -c "${PC[*]} context 'slugify keeps repeated hyphens' --repo bench/agent/fixture -k 1 | grep -q '1. src/utils/slugify.ts'"
check "tune plan refuses (no data), runs nothing" bash -c "${PC[*]} tune plan --repo bench/agent/fixture | grep -q 'not ready'"

# learn collect on a disposable repo with a real passing change
TMP=$(mktemp -d); cp -R bench/agent/fixture/. "$TMP"; (cd "$TMP" && git init -q && git add -A && git -c user.email=e@e -c user.name=e commit -qm base && sed -i '' 's/Math.min(100,/Math.min(200,/' src/utils/paginate.ts)
check "learn collect (approved, tests pass)" bash -c "${PC[*]} learn collect --repo $TMP --task 'allow page size 200' --approve | grep -q 'saved'"
check "learn export → MLX-LM jsonl" bash -c "${PC[*]} learn export --repo $TMP | grep -q 'kept 1'"

# gateway on the real backend
PITCREW_LOG=normal "${PC[@]}" serve --config examples/pitcrew.config.json --port "$PORT" > /tmp/e2e-gw.log 2>&1 & GWPID=$!
for i in $(seq 1 40); do curl -sf "$GW/healthz" >/dev/null && break; sleep 0.5; done
check "gateway /healthz" bash -c "curl -sf $GW/healthz | grep -q ok"
check "/v1/models: aliases + router, no cloud" bash -c "curl -s $GW/v1/models | grep -q '\"auto\"' && ! curl -s $GW/v1/models | grep -q 'cloud'"
check "cloud model refused (403)" bash -c "test \$(curl -s -o /dev/null -w '%{http_code}' $GW/v1/chat/completions -H 'content-type: application/json' -d '{\"model\":\"kimi-k2.5:cloud\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}') = 403"
check "oversize prompt refused, not truncated (400)" bash -c "python3 -c \"import json;print(json.dumps({'model':'small','messages':[{'role':'user','content':'word '*120000}]}))\" > /tmp/e2e-big.json && test \$(curl -s -o /dev/null -w '%{http_code}' $GW/v1/chat/completions -H 'content-type: application/json' -d @/tmp/e2e-big.json) = 400"
check "router: helper → small, thinking off" bash -c "curl -s -D - -o /tmp/e2e-h.json $GW/v1/chat/completions -H 'content-type: application/json' -d '{\"model\":\"auto\",\"messages\":[{\"role\":\"system\",\"content\":\"Generate a short title.\"},{\"role\":\"user\",\"content\":\"fix login bug\"}]}' | grep -qi 'x-pitcrew-route: helper->small' && python3 -c \"import json;d=json.load(open('/tmp/e2e-h.json'));assert d['choices'][0]['message']['content'].strip()\""
check "coder: real OpenCode request → valid tool call" bash -c "python3 -c \"import json;r=json.load(open('bench/load/opencode-request.json'));r.update(model='coder',max_tokens=512);print(json.dumps(r))\" > /tmp/e2e-agent.json && curl -s -m 600 $GW/v1/chat/completions -H 'content-type: application/json' -d @/tmp/e2e-agent.json | python3 -c \"import json,sys;d=json.load(sys.stdin);tc=d['choices'][0]['message'].get('tool_calls') or [];assert tc and tc[0]['function']['name'] in ('glob','bash','read','grep'),d;json.loads(tc[0]['function']['arguments'])\""
check "streaming SSE through gateway ends with [DONE]" bash -c "curl -s -N $GW/v1/chat/completions -H 'content-type: application/json' -d '{\"model\":\"small\",\"stream\":true,\"reasoning_effort\":\"none\",\"max_tokens\":20,\"messages\":[{\"role\":\"user\",\"content\":\"say hi\"}]}' | grep -q 'data: \[DONE\]'"
check "native /api/chat through gateway" bash -c "curl -s $GW/api/chat -d '{\"model\":\"small\",\"stream\":false,\"think\":false,\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}]}' | grep -q '\"done\":true'"
check "calibration recorded measured sizes" bash -c "test -s \$HOME/.pitcrew/calibration.json"
check "/governor/state reports measured memory" bash -c "curl -s $GW/governor/state | grep -q '\"measured\":true'"
check "/metrics prometheus" bash -c "curl -s $GW/metrics | grep -q 'pitcrew_requests_total'"
check "dashboard HTML served" bash -c "curl -s $GW/ | grep -q 'PIT CREW'"
check "SSE /governor/events streams state" bash -c "curl -s -N -m 3 $GW/governor/events | grep -q 'event: state'"
check "manual unload" bash -c "curl -s -XPOST $GW/governor/unload -d '{\"model\":\"small\"}' | grep -q unloaded"
check "status command" bash -c "${PC[*]} status | grep -q memory"
check "OpenCode → Pit Crew: file edit + test run" bash -c "
  D=\$(mktemp -d); cp -R bench/agent/fixture/. \$D; cd \$D && git init -q && git add -A && git -c user.email=e@e -c user.name=e commit -qm base
  # stdin from /dev/null: \`opencode run\` reads piped stdin and waits for it to close (hung here 11-04).
  OPENCODE_CONFIG=$ROOT/examples/opencode/opencode.pitcrew.json OPENCODE_CONFIG_CONTENT='{\"permission\":{\"edit\":\"allow\",\"bash\":\"allow\",\"external_directory\":\"deny\"}}' \
  OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1 \
  perl -e 'alarm 600; exec @ARGV' opencode run --pure -m pitcrew/auto 'Add a function export const VERSION = \"0.3.0\" in src/version.ts, then run npm test.' </dev/null >/tmp/e2e-opencode.log 2>&1
  if grep -q '0.3.0' src/version.ts && npm test 2>&1 | grep -q '^# fail 0'; then exit 0; fi
  echo \"see /tmp/e2e-opencode.log:\"; tail -c 300 /tmp/e2e-opencode.log | tr -s '\\n' ' '; exit 1"
check "no cloud in governed run (gateway log)" bash -c "! grep -qi 'cloud' /tmp/e2e-gw.log"
check "pitcrew clean (dry run lists derived models)" bash -c "${PC[*]} clean | grep -q 'pitcrew/'"
kill $GWPID 2>/dev/null; wait $GWPID 2>/dev/null
for m in $(curl -s http://127.0.0.1:11434/api/ps | python3 -c 'import json,sys;print(" ".join(x["name"] for x in json.load(sys.stdin)["models"]))'); do curl -s http://127.0.0.1:11434/api/generate -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null; done

printf '%s\n' "${rows[@]}"
echo "----"; echo "e2e: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
