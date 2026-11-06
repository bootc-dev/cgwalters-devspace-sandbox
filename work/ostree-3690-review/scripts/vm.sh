#!/bin/bash
# Usage: bash vm.sh DISK SSHPORT [EXTRA_DISK]
# Boots DISK with SeaBIOS (q35 without pflash, so no UEFI and the ESP is
# unused); the serial console goes to DISK.serial.log. Root's SSH key is
# provisioned through a systemd credential. Run it inside the vmhost container
# (see Containerfile.vmhost) when the host has no qemu.
set -euo pipefail
disk=$1; port=$2
key=${VM_SSH_KEY:-/var/tmp/w/ssh/id}
cred=$(base64 -w0 < "$key.pub")
exec "${QEMU:-/usr/libexec/qemu-kvm}" -machine q35,accel=kvm -cpu host -smp 4 -m 4096 \
  -drive file="$disk",if=virtio,format=qcow2 ${3:+-drive file="$3",if=virtio,format=qcow2} \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:"$port"-:22 -device virtio-net-pci,netdev=n0 \
  -smbios type=11,value=io.systemd.credential.binary:ssh.authorized_keys.root="$cred" \
  -serial file:"$disk".serial.log -monitor none -display none
