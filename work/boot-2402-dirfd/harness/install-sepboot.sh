#!/bin/bash
# Usage: install-sepboot.sh IMAGE DISK
# BIOS boot, ESP, a separate ext4 /boot and an xfs root, installed with to-filesystem.
set -euo pipefail
truncate -s 30G "$2"; t=$(mktemp -d)
sgdisk -o -n1:0:+1M -t1:EF02 -n2:0:+512M -t2:EF00 -n3:0:+1G -t3:8300 -n4:0:0 -t4:8304 "$2" >/dev/null
dev=$(losetup -fP --show "$2"); udevadm settle
mkfs.vfat -n EFI "${dev}p2" >/dev/null; mkfs.ext4 -q -L boot "${dev}p3"; mkfs.xfs -q -L root "${dev}p4"
mount "${dev}p4" "$t"; mkdir "$t/boot"; mount "${dev}p3" "$t/boot"; mkdir "$t/boot/efi"; mount "${dev}p2" "$t/boot/efi"
podman run --rm --privileged --pid=host -v /dev:/dev -v /var/lib/containers:/var/lib/containers \
  -v /var/tmp:/var/tmp -v "$t:/target" --security-opt label=type:unconfined_t "$1" \
  bootc install to-filesystem --generic-image --karg console=ttyS0 \
  --root-ssh-authorized-keys /var/tmp/spike/key.pub /target
umount -R "$t"; losetup -d "$dev"
