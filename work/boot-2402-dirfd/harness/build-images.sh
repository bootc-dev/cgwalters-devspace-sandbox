#!/bin/bash
# Usage: build-images.sh VARIANT...  (run as root in the builder, from the spike dir)
# Builds localhost/{bootc,silverblue}-VARIANT from out/VARIANT; "stock" is the base image.
set -euo pipefail
declare -A bases=([bootc]=quay.io/fedora/fedora-bootc:44 [silverblue]=quay.io/fedora-ostree-desktops/silverblue:44)
for v in "$@"; do for b in "${!bases[@]}"; do
  if [ "$v" = stock ]; then podman tag "${bases[$b]}" "localhost/$b-stock"; continue; fi
  podman build -q --build-arg BASE="${bases[$b]}" -f harness/Containerfile -t "localhost/$b-$v" "out/$v"
done; done
