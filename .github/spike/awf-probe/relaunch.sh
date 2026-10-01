#!/bin/bash
# relaunch.sh NAME IP [extra docker run args...]
# Start a sibling of awf-agent on awf-net with the same image, binds, tmpfs,
# caps and network, but idle (sleep) so we can drive it. Env knobs:
#   SECCOMP=awf|unconfined|FILE  NNP=1|0
set -euo pipefail
name=$1 ip=$2; shift 2
insp=$(docker inspect awf-agent)
hc() { jq -r ".[0].HostConfig.$1" <<<"$insp"; }
args=(--name "$name" -d --network awf-net --ip "$ip" --memory 6g --pids-limit 4000)
while read -r b; do args+=(-v "$b"); done < <(hc 'Binds[]')
while read -r t; do args+=(--tmpfs "$t"); done < <(jq -r '.[0].HostConfig.Tmpfs | to_entries[] | "\(.key):\(.value)"' <<<"$insp")
while read -r c; do args+=(--cap-add "$c"); done < <(hc 'CapAdd[]')
while read -r c; do args+=(--cap-drop "$c"); done < <(hc 'CapDrop[]')
while read -r h; do args+=(--add-host "$h"); done < <(hc 'ExtraHosts[]')
jq -r '.[0].HostConfig.SecurityOpt[] | select(startswith("seccomp="))' <<<"$insp" | sed 's/^seccomp=//' > /tmp/awf-seccomp.json
case "${SECCOMP:-awf}" in
  awf) args+=(--security-opt seccomp=/tmp/awf-seccomp.json);;
  unconfined) args+=(--security-opt seccomp=unconfined);;
  *) args+=(--security-opt "seccomp=$SECCOMP");;
esac
[ "${NNP:-1}" = 1 ] && args+=(--security-opt no-new-privileges:true)
args+=(--security-opt apparmor:unconfined)
img=$(jq -r '.[0].Config.Image' <<<"$insp")
docker rm -f "$name" >/dev/null 2>&1 || true
docker run "${args[@]}" "$@" --entrypoint /bin/sleep "$img" infinity
