#!/bin/bash
# Usage: install-onroot.sh IMAGE DISK
# bootc install to-disk's default layout: BIOS boot, ESP, and root holding /boot.
set -euo pipefail
truncate -s 30G "$2"
podman run --rm --privileged --pid=host -v /dev:/dev -v /var/lib/containers:/var/lib/containers \
  -v /var/tmp:/var/tmp --security-opt label=type:unconfined_t "$1" \
  bootc install to-disk --via-loopback --generic-image --filesystem xfs --karg console=ttyS0 \
  --root-ssh-authorized-keys /var/tmp/spike/key.pub "$(realpath "$2")"
