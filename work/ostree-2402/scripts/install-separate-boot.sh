#!/bin/bash
# Runs inside `bcvk ephemeral run-ssh --bind-storage-ro --mount-disk-file DISK:output`:
# partitions the disk as BIOS boot + (unused) ESP + separate ext4 /boot + xfs
# root, and installs IMAGE with `bootc install to-filesystem`.
# Usage: bash install-separate-boot.sh IMAGE
set -xeuo pipefail
image=$1; dev=/dev/disk/by-id/virtio-output
printf 'label: gpt\nsize=1M, type=21686148-6449-6E6F-744E-656564454649\nsize=512M, type=U\nsize=1G, type=L\ntype=4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709\n' | sfdisk "$dev"
udevadm settle
mkfs.vfat "${dev}-part2"; mkfs.ext4 -q "${dev}-part3"; mkfs.xfs -q "${dev}-part4"
mkdir -p /var/mnt/t && mount "${dev}-part4" /var/mnt/t && mkdir /var/mnt/t/boot && mount "${dev}-part3" /var/mnt/t/boot
export STORAGE_OPTS=additionalimagestore=/run/virtiofs-mnt-hoststorage/
podman run --rm --privileged --pid=host --net=none -v /dev:/dev -v /var/lib/containers:/var/lib/containers \
  -v /var/mnt/t:/target -v /run/virtiofs-mnt-hoststorage:/run/virtiofs-mnt-hoststorage --env=STORAGE_OPTS \
  --security-opt label=type:unconfined_t "$image" \
  bootc install to-filesystem --generic-image --skip-fetch-check /target
umount -R /var/mnt/t
