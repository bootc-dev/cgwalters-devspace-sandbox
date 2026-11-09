#!/bin/bash
# Usage: install-all.sh VARIANT...  (run as root in the builder, from the spike dir)
# Installs the disks run-matrix.sh expects into disks/, all in parallel.
set -uo pipefail
h=$(dirname "$(realpath "$0")"); mkdir -p disks logs
for v in "$@"; do
  echo "onroot localhost/bootc-$v disks/bootc-$v-onroot.raw"; echo "sepboot localhost/bootc-$v disks/bootc-$v-sepboot.raw"
  echo "onroot localhost/silverblue-$v disks/silverblue-$v-onroot.raw"
done | xargs -P 0 -L 1 bash -c 'bash "$0/install-$1.sh" "$2" "$3" > "logs/$(basename "$3").log" 2>&1; echo "$3: rc=$?"' "$h"
