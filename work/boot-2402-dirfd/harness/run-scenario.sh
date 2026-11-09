#!/bin/bash
# Usage: run-scenario.sh DISK.raw OUTDIR SSHPORT [automount|umount]
# Boot, let a /boot automount idle out (120s for gpt-auto's), stage a deployment
# with a marker karg, wait again, reboot, and check that the marker booted.
set -uo pipefail
h=$(dirname "$(realpath "$0")"); mkdir -p "$2"; o=$(realpath "$2"); port=$3; mode=${4:-}
g() { ssh -q -i /var/tmp/spike/key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=5 -p "$port" root@127.0.0.1 bash -s -- "$@" < "$h/guest.sh"; }
wait_boot() { for _ in $(seq 240); do id=$(g bootid 2>/dev/null) && [ "$id" != "${1:-}" ] && return; sleep 5; done
  echo "VM did not come up"; exit 1; }
reboot_vm() { local id; id=$(g bootid); g reboot; wait_boot "$id"; }
trap 'kill "$(cat "$o/qemu.pid")" 2>/dev/null' EXIT
bash "$h/vm.sh" "$1" "$o" "$port" && wait_boot && g info > "$o/0-info.txt" 2>&1
if [ "$mode" = automount ]; then g automount && reboot_vm; fi
sleep 150; g bootstate > "$o/1-before-stage.txt" 2>&1
g stage > "$o/2-stage.txt" 2>&1
if [ "$mode" = umount ]; then g umount >> "$o/2-stage.txt" 2>&1; fi
sleep 150; g bootstate > "$o/3-before-reboot.txt" 2>&1
reboot_vm; g check > "$o/4-check.txt" 2>&1
echo "$o: $(grep RESULT "$o/4-check.txt")"
