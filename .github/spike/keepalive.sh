#!/bin/bash
# Stand-in for the agent CLI (engine.command): run nested-container
# diagnostics once, then keep the agent step alive for a human on ssh.
echo "[spike] keepalive pid $$ as $(id)" >&2
bash /tmp/gh-aw/spike/diag.sh >&2 || true
minutes=$(cat /tmp/gh-aw/spike/duration 2>/dev/null || echo 30)
end=$(( $(date +%s) + minutes * 60 ))
while [ "$(date +%s)" -lt "$end" ] && [ ! -e /tmp/gh-aw/spike/stop ]; do
  echo '{"type":"system","subtype":"spike-keepalive"}'
  sleep 60
done
