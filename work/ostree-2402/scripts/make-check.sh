#!/bin/bash
# Usage: bash make-check.sh SRCDIR LOG
# Configures as scripts/Containerfile does, builds, and runs `make check` in
# its buildroot stage (tagged localhost/ostree-buildroot), unprivileged.
src=$1; log=$2
podman run --rm --network=none --security-opt label=disable -v "$src":/src -w /src localhost/ostree-buildroot bash -c '
  env NOCONFIGURE=1 ./autogen.sh && ./configure --prefix=/usr --libdir=/usr/lib64 --libexecdir=/usr/libexec \
    --sysconfdir=/etc --localstatedir=/var --disable-gtk-doc --with-selinux --with-curl --with-openssl \
    --without-soup --with-soup3 --with-composefs --with-dracut=yesbutnoconf >/dev/null &&
  make -j$(nproc) >/dev/null && make -j$(nproc) check; echo "make-check-rc=$?"' > "$log" 2>&1
