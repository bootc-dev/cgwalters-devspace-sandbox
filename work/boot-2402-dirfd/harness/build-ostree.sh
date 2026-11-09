#!/bin/bash
# Usage: build-ostree.sh VARIANT...  (run as root in the builder, from the spike dir)
# Builds src-VARIANT in a fedora:44 container and installs it into out/VARIANT.
# The CA bundle mount passes an egress proxy's CA through; it is harmless without one.
set -euo pipefail
for v in "$@"; do mkdir -p "out/$v"; done
printf '%s\n' "$@" | xargs -P 0 -I{} podman run --rm --net=host -v "$PWD:/w" \
  -v /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem:/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem:ro -w "/w/src-{}" quay.io/fedora/fedora:44 bash -c '
  dnf -q -y install dnf-plugins-core git >/dev/null && dnf -q -y builddep ostree >/dev/null && env NOCONFIGURE=1 ./autogen.sh &&
  ./configure -q --prefix=/usr --libdir=/usr/lib64 --sysconfdir=/etc --localstatedir=/var --with-selinux --with-curl \
    --with-openssl --without-soup --with-composefs --with-dracut=yesbutnoconf --disable-man --disable-gtk-doc &&
  make -s -j16 && make -s install DESTDIR=/w/out/{}' > build.log 2>&1
