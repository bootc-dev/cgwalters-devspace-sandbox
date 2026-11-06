#!/bin/bash
# Usage: bash idle-stage-reboot.sh SSHPORT KARG
# On a booted VM: idle past the boot.automount timeout, check /boot from a new
# mount namespace, stage a redeploy of the booted commit with KARG appended,
# idle again, reboot, and report what booted and the finalize logs.
set -uo pipefail
port=$1; karg=$2
v() { bash "$(dirname "$0")/vssh.sh" "$port" "$@"; }
idle=190
sleep $idle
v 'uptime; findmnt -R /boot; unshare -m ostree admin status; echo "unshare-status-rc=$?"'
v "csum=\$(ostree admin status | awk '/^\\* /{print \$3}' | sed 's/\\.[0-9]*\$//');
   ostree admin deploy --stage --karg-append=$karg \$csum; echo deploy-rc=\$?; ostree admin status"
sleep $idle
v 'uptime; timeout 20 findmnt -R /boot; timeout 60 unshare -m ostree admin status; echo "unshare-status-rc=$?";
   systemctl is-active ostree-finalize-staged.service; systemctl reboot'
sleep 30
for _ in $(seq 60); do v true && break; sleep 5; done
v 'cat /proc/cmdline; ostree admin status;
   journalctl -b -1 -o short-precise --no-pager -u ostree-finalize-staged.service \
     -u ostree-finalize-staged-hold.service -u boot.mount -u boot.automount | tail -40'
