#!/bin/bash
# Runs inside the test VM as root.
# Usage: guest.sh info|bootstate|stage|automount|umount|bootid|reboot|check
MARKER=spike.marker=1
case "$1" in
bootid) cat /proc/sys/kernel/random/boot_id ;;
reboot) systemctl reboot ;;
umount) umount /boot; echo "umount /boot: rc=$?"; findmnt /boot ;;
info) ostree --version | head -3; bootc --version; lsblk -o NAME,SIZE,FSTYPE,PARTTYPENAME,MOUNTPOINTS
  cat /etc/fstab; ostree config --repo=/sysroot/ostree/repo get sysroot.bootloader; getenforce ;;
bootstate) date; findmnt /boot; systemctl is-active boot.mount boot.automount ostree-finalize-staged.service ;;
stage) bootc status >/dev/null; echo "bootc status: rc=$?"; ostree admin status; echo "ostree admin status: rc=$?"
  ostree admin kargs edit-in-place --append-if-missing=spike.interactive=1; echo "kargs edit-in-place: rc=$?"
  csum=$(ostree admin status | sed -n 's/^\* [^ ]* \([0-9a-f]*\)\..*/\1/p')
  ostree admin deploy --stage --karg-proc-cmdline --karg-append=$MARKER "$csum"; echo "deploy --stage: rc=$?" ;;
automount) sed -i -E '/[[:space:]]\/boot[[:space:]]/s/^(\S+\s+\S+\s+\S+\s+\S+)/\1,x-systemd.automount,x-systemd.idle-timeout=60/' /etc/fstab
  grep /boot /etc/fstab ;;
check) cat /proc/cmdline; grep -q "$MARKER" /proc/cmdline && echo "RESULT: staged deployment booted" || echo "RESULT: staged deployment LOST"
  ls -Z /boot/loader/entries/; grep -H spike.interactive /boot/loader/entries/*
  echo "AVC denials in previous boot: $(journalctl -b -1 --no-pager | grep -c 'avc:  denied')"; journalctl -b -1 -o short-monotonic --no-pager \
    -u ostree-finalize-staged.service -u ostree-finalize-staged-hold.service -u boot.mount -u boot.automount | tail -40 ;;
esac
