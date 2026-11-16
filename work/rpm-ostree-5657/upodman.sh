#!/bin/bash
# Podman inside a single-uid user namespace, for sandboxes where rootless
# podman's newuidmap can't see the target PID. The environment tells podman
# it is already in its rootless namespace. State goes under $R5657.
set -euo pipefail
p=${R5657:-/var/tmp/r5657}/pm
mkdir -p "$p"/{storage,run}
export CONTAINERS_CONF="$(dirname "$(realpath "$0")")/containers.conf" XDG_RUNTIME_DIR=/run
export _CONTAINERS_USERNS_CONFIGURED=1 _CONTAINERS_ROOTLESS_UID="$(id -u)" _CONTAINERS_ROOTLESS_GID="$(id -g)"
mkdir -p "$p/run/lock"
exec unshare -rm sh -c 'mount --bind "$0/run" /run && exec podman --root "$0/storage" --runroot /run \
  --storage-driver vfs --storage-opt vfs.ignore_chown_errors=true "$@"' "$p" "$@"
