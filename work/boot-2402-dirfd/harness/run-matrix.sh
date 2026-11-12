#!/bin/bash
# Usage: run-matrix.sh VARIANT...  (from the spike dir, after installing disks/)
# Runs every scenario for each variant that has no results yet, $JOBS (default 4)
# VMs at a time, into results/.
set -uo pipefail
h=$(dirname "$(realpath "$0")"); port=2400
for v in "$@"; do for s in bootc-onroot: bootc-sepboot: bootc-sepboot:automount bootc-sepboot:umount silverblue-onroot:; do
  port=$((port + 1)); d=${s%%:*}; m=${s#*:}; disk="${d%-*}-$v-${d#*-}"
  # Skip scenarios that already have results. No trailing blank: xargs -L would
  # join the next line onto this one.
  [ -e "results/$disk${m:+-$m}" ] || echo "disks/$disk.raw results/$disk${m:+-$m} $port${m:+ $m}"
done; done | xargs -P "${JOBS:-4}" -L 1 bash "$h/run-scenario.sh"
