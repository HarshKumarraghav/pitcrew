#!/usr/bin/env bash
# Record every non-loopback TCP connection held by opencode/ollama processes, once per second.
# usage: netwatch.sh <outfile> <seconds>      output: <unix-time> <process> <pid> <local->remote>
out="$1"; secs="${2:-3600}"; : > "$out"
end=$(( $(date +%s) + secs ))
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(date +%s)
  lsof -nP -iTCP -sTCP:ESTABLISHED 2>/dev/null | awk -v t="$now" 'NR>1 && ($1 ~ /^(opencode|ollama)/) {print t, $1, $2, $9}' \
    | grep -v -E -- '->(127\.0\.0\.1|\[::1\]|localhost):' >> "$out" || true
  sleep 1
done
