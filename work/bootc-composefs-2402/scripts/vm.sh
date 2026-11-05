#!/bin/bash
# Usage: [FIRMWARE=uefi] bash vm.sh DISK SSHPORT [EXTRA_DISK]
# Boots DISK with SeaBIOS by default (q35 without pflash, so no UEFI and the
# ESP is unused), or with OVMF when FIRMWARE=uefi, keeping its variable store
# in DISK.vars.fd. The serial console goes to DISK.serial.log. Root's SSH key
# is provisioned through a systemd credential.
set -euo pipefail
disk=$1; port=$2
key=${VM_SSH_KEY:-/var/tmp/w/ssh/id}
cred=$(base64 -w0 < "$key.pub")
fw=()
if [ "${FIRMWARE:-bios}" = uefi ]; then
  test -f "$disk.vars.fd" || cp /usr/share/edk2/ovmf/OVMF_VARS.fd "$disk.vars.fd"
  fw=(-drive if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/edk2/ovmf/OVMF_CODE.fd
      -drive if=pflash,format=raw,unit=1,file="$disk.vars.fd")
fi
exec /usr/libexec/qemu-kvm -machine q35,accel=kvm -cpu host -smp 4 -m 4096 "${fw[@]}" \
  -drive file="$disk",if=virtio,format=qcow2 ${3:+-drive file="$3",if=virtio,format=qcow2} \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:"$port"-:22 -device virtio-net-pci,netdev=n0 \
  -smbios type=11,value=io.systemd.credential.binary:ssh.authorized_keys.root="$cred" \
  -serial file:"$disk".serial.log -monitor none -display none
