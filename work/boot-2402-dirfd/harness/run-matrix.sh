#!/bin/bash
# Usage: run-matrix.sh VARIANT...  (from the spike dir, after installing disks/)
# Runs every scenario for each variant, four VMs at a time, into results/.
set -euo pipefail
for cmd in qemu-img qemu-system-x86_64 ssh; do command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd" >&2; exit 1; }; done
h=$(dirname "$(realpath "$0")"); port=2400
for v in "$@"; do for s in bootc-onroot: bootc-sepboot: bootc-sepboot:automount bootc-sepboot:umount silverblue-onroot:; do
  port=$((port + 1)); d=${s%%:*}; m=${s#*:}; disk="${d%-*}-$v-${d#*-}"
  printf '%s\0' "disks/$disk.raw" "results/$disk${m:+-$m}" "$port" "$m"
done; done | xargs -0 -P 4 -n 4 bash "$h/run-scenario.sh"
