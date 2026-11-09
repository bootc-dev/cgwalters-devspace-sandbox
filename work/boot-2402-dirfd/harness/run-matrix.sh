#!/bin/bash
# Usage: run-matrix.sh VARIANT...  (from the spike dir, after installing disks/)
# Runs every scenario for each variant, four VMs at a time, into results/.
set -uo pipefail
h=$(dirname "$(realpath "$0")"); port=2400
for v in "$@"; do for s in bootc-onroot: bootc-sepboot: bootc-sepboot:automount bootc-sepboot:umount silverblue-onroot:; do
  port=$((port + 1)); d=${s%%:*}; m=${s#*:}; disk="${d%-*}-$v-${d#*-}"
  echo "disks/$disk.raw results/$disk${m:+-$m} $port $m"
done; done | xargs -P 4 -L 1 bash "$h/run-scenario.sh"
