#!/usr/bin/env bash
# Re-run every Claude Code result marked invalid (e.g. "machine slept"), same model, same repeat,
# overwriting the invalid result in place. Keeps the Mac awake while running.
set -uo pipefail
if [ -z "${PITCREW_CAFFEINATED:-}" ]; then export PITCREW_CAFFEINATED=1; exec caffeinate -ims "$0" "$@"; fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
python3 - <<'PY' > /tmp/rerun-plan.txt
import json, glob, os, re
plan = {}
for p in sorted(glob.glob("bench/agent/results/cc-*-r*/*.json")):
    if not re.search(r"/[A-P]\.json$", p): continue
    r = json.load(open(p))
    if r.get("invalid"):
        d = os.path.basename(os.path.dirname(p))
        plan.setdefault(d, []).append(os.path.basename(p)[0])
for d, ts in plan.items():
    m = re.match(r"cc-(.+)-r(\d+)$", d)
    print(f"claude-{m.group(1)} {m.group(2)} {','.join(sorted(ts))}")
PY
echo "rerun plan:"; cat /tmp/rerun-plan.txt
while read -r model rep tasks; do
  [ -z "$model" ] && continue
  echo "[$(date +%H:%M:%S)] rerun $model r$rep tasks $tasks"
  node bench/agent/run.mjs --agent claude --model "$model" --label "cc-${model#claude-}" --repeat "$rep" --tests "$tasks" --timeout 900
done < /tmp/rerun-plan.txt
node bench/summarize.mjs > /tmp/summary-claude.md
echo RERUN-DONE
