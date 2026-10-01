#!/bin/bash
# Checks the host-user sandbox demo agent runs with its Bash tool. Each line
# of output is "CHECK <name>: <result>".
set -u
check() { printf 'CHECK %s: %s\n' "$1" "$2"; }

check identity "$(id)"
check session "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-unset}"
if sudo -n true 2>/dev/null; then check sudo "UNEXPECTED: sudo works"; else check sudo "denied (expected)"; fi
if ls /home/runner/.. >/dev/null 2>&1 && ls -A /home/runner 2>/dev/null | grep -qv '^work$'; then
  check runner-home "UNEXPECTED: visible: $(ls -A /home/runner | head -5 | tr '\n' ' ')"
else
  check runner-home "hidden (only the workspace path is mounted)"
fi
secrets=$(env | grep -c -E '^(ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN|ACTIONS_RUNTIME_TOKEN)=' || true)
check secret-env "${secrets} credential variables in the environment"
check inference "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-unset} OPENAI_BASE_URL=${OPENAI_BASE_URL:-unset}"

d=$(mktemp -d)
cat >"$d/Containerfile" <<'CF'
FROM quay.io/fedora/fedora:latest
RUN useradd -u 2000 bob && install -o bob -g bob -d /data && touch /data/f && chown bob:bob /data/f && ls -ln /data/f
CF
if out=$(timeout 600 podman build -q -t localhost/host-user-demo "$d" 2>&1); then
  check podman-build "ok (multi-uid image $(echo "$out" | tail -1 | cut -c1-12))"
else
  check podman-build "FAILED: $(echo "$out" | tail -3 | tr '\n' ' ')"
fi
if out=$(timeout 300 podman run --rm localhost/host-user-demo sh -c 'stat -c "%u:%g" /data/f; cat /proc/self/uid_map | head -1' 2>&1); then
  check podman-run "ok: $(echo "$out" | tr -s ' \n' ' ')"
else
  check podman-run "FAILED: $(echo "$out" | tail -3 | tr '\n' ' ')"
fi
check kvm "$(ls -l /dev/kvm 2>&1)"
if out=$(python3 -c 'import os,fcntl; fd=os.open("/dev/kvm",os.O_RDWR); print("KVM_GET_API_VERSION", fcntl.ioctl(fd,0xAE00))' 2>&1); then
  check kvm-open "ok: $out"
else
  check kvm-open "FAILED: $out"
fi
