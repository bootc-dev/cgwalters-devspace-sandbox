#!/bin/bash
# Usage: bash make-check.sh SRCDIR LOG [IMAGE]
# Configures as scripts/Containerfile does, builds, and runs `make check`
# unprivileged in IMAGE (default: its buildroot stage, localhost/ostree-buildroot).
src=$1; log=$2; image=${3:-localhost/ostree-buildroot}
podman run --rm --network=none --security-opt label=disable -v "$src":/src -w /src "$image" bash -c '
  env NOCONFIGURE=1 ./autogen.sh && ./configure --prefix=/usr --libdir=/usr/lib64 --libexecdir=/usr/libexec \
    --sysconfdir=/etc --localstatedir=/var --disable-gtk-doc --with-selinux --with-curl --with-openssl \
    --without-soup --with-soup3 --with-composefs --with-dracut=yesbutnoconf >/dev/null &&
  make -j$(nproc) >/dev/null && make -j$(nproc) check; echo "make-check-rc=$?"' > "$log" 2>&1
