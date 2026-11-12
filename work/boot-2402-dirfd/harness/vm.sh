#!/bin/bash
# Usage: vm.sh DISK.raw RUNDIR SSHPORT
# Boot a throwaway qcow2 overlay of DISK with SeaBIOS, so the ESP is present but
# unused: that is what makes systemd-gpt-auto-generator automount it on /boot.
set -euo pipefail
qemu-img create -q -f qcow2 -F raw -b "$(realpath "$1")" "$2/disk.qcow2"
qemu-system-x86_64 -enable-kvm -cpu host -smp 4 -m 4096 -display none -monitor none \
  -drive file="$2/disk.qcow2",if=virtio,cache=unsafe -serial file:"$2/serial.log" \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:"$3"-:22 -device virtio-net-pci,netdev=n0 \
  -daemonize -pidfile "$2/qemu.pid"
