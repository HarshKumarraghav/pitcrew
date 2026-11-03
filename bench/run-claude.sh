#!/usr/bin/env bash
# Claude Code (cloud models) as a yardstick on the same tasks, fixture and hidden verifiers.
# Never part of Pit Crew. Uses the logged-in Claude Code account (counts against your usage);
# no permission bypass (allow-list + dontAsk).
#
# usage: RUNS=3 TASKS=A,B,C,…,P MODELS="claude-opus-4-5 claude-opus-4-6 claude-opus-4-7" bench/run-claude.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
RUNS="${RUNS:-3}"
TASKS="${TASKS:-A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P}"
MODELS="${MODELS:-claude-opus-4-5 claude-opus-4-6 claude-opus-4-7}"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude (Claude Code CLI) not found on PATH — skipping the Claude reference runs." >&2
  exit 0
fi

# One-line probe per model ID: skip the ones this account cannot use, and say so.
AVAILABLE=()
for m in $MODELS; do
  out="$(cd /tmp && perl -e 'alarm 120; exec @ARGV' claude -p --model "$m" --setting-sources project,local --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence --output-format json "Reply with the single word: ok" 2>&1)"
  if echo "$out" | grep -q '"is_error":false' && echo "$out" | grep -qi '"result":"ok'; then
    AVAILABLE+=("$m")
    echo "[probe] $m available"
  else
    echo "[probe] $m NOT available — skipped ($(echo "$out" | tr '\n' ' ' | cut -c1-160))"
  fi
done
[ ${#AVAILABLE[@]} -eq 0 ] && { echo "no Claude model available; nothing to run"; exit 0; }

for r in $(seq 1 "$RUNS"); do
  for m in "${AVAILABLE[@]}"; do
    echo "[$(date +%H:%M:%S)] claude code $m run $r"
    node bench/agent/run.mjs --agent claude --model "$m" --label "cc-${m#claude-}" --repeat "$r" --tests "$TASKS" --timeout 900
  done
done
node bench/summarize.mjs > /tmp/summary-claude.md
echo CLAUDE-DONE
