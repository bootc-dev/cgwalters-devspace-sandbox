#!/bin/bash
# Run a command in a rootfs as uid 0 of a single-uid user namespace, with the
# rpm-ostree checkout at /src, $R5657_DATA (if set) at /data and the egress
# proxy CA trusted. Usage: uchroot.sh ROOTFS SRC CMD...
set -euo pipefail
root=$(realpath "$1") src=$(realpath "$2"); shift 2
exec unshare -rm --fork sh -c 'r=$1 s=$2; shift 2
  for d in proc sys dev; do mount --rbind /$d $r/$d; done
  mkdir -p $r/src $r/data && mount --bind $s $r/src
  if test -n "${R5657_DATA:-}"; then mount --bind $R5657_DATA $r/data; fi
  cp -L /etc/resolv.conf $r/etc/resolv.conf
  if test -e /etc/egress-proxy/ca.pem; then cp /etc/egress-proxy/ca.pem $r/etc/pki/ca-trust/source/anchors/egress-proxy.pem &&
    chroot $r update-ca-trust; fi
  exec /usr/sbin/chroot $r /usr/bin/env -C /src HOME=/root PATH=/root/.cargo/bin:/usr/local/bin:/usr/bin:/usr/sbin "$@"' sh "$root" "$src" "$@"
