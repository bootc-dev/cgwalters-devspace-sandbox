#!/bin/bash
# Usage: [NOHOLD=1] bash idle-stage-reboot.sh SSHPORT IMAGE MARKER [automount]
# On a booted composefs VM: copy IMAGE (built by ./Containerfile with MARKER)
# into it, idle past the boot.automount timeout, stage IMAGE with
# `bootc switch`, idle again, reboot, and report what booted and the logs.
# With `automount`, first point /run/systemd/volatile-root at /sysroot's
# device, as ostree-prepare-root does, so systemd-gpt-auto-generator finds
# the disk and sets up boot.automount for the ESP. A UEFI boot with a DPS root
# (vm.sh with FIRMWARE=uefi) gets that automount on its own.
set -uo pipefail
port=$1; image=$2; marker=$3
v() { bash "$(dirname "$0")/vssh.sh" "$port" "$@"; }
idle=190
# Not containers-storage: an image loaded from `podman save`'s default
# docker-archive fails the composefs pull with "Invalid splitstream content type".
podman save --format oci-archive "$image" | v 'cat > /var/tmp/up.ociarchive'
if [ "${4:-}" = automount ]; then
  v 'ln -s /dev/block/$(mountpoint -d /sysroot) /run/systemd/volatile-root && systemctl daemon-reload &&
     systemctl start boot.automount && systemctl status --no-pager boot.automount | head -3'
fi
sleep $idle
v 'uptime; findmnt -R /boot; systemctl is-active boot.automount; unshare -m ls /boot; echo "unshare-ls-rc=$?"'
v 'bootc switch --transport oci-archive /var/tmp/up.ociarchive; echo switch-rc=$?; bootc status'
# Negative control: without the hold, nothing keeps /boot busy until shutdown.
if [ -n "${NOHOLD:-}" ]; then
  v 'systemctl stop bootc-finalize-staged-hold.service; systemctl is-active bootc-finalize-staged.service bootc-finalize-staged-hold.service'
fi
sleep $idle
v 'uptime; timeout 20 findmnt -R /boot; systemctl is-active bootc-finalize-staged.service bootc-finalize-staged-hold.service;
   hold=$(systemctl show -P MainPID bootc-finalize-staged-hold.service); echo "hold-pid=$hold";
   [ "$hold" != 0 ] && ls -l /proc/$hold/fd | grep -w /boot;
   systemctl reboot'
sleep 30
for _ in $(seq 60); do v true && break; sleep 5; done
v "cat /usr/share/bz2402-marker; grep -q '^$marker\$' /usr/share/bz2402-marker; echo marker-match-rc=\$?; bootc status;
   journalctl -b -1 -o short-precise --no-pager -u bootc-finalize-staged.service \
     -u bootc-finalize-staged-hold.service -u 'boot*' -u 'efi*' | tail -60"
