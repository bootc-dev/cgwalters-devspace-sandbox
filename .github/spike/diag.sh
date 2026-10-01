#!/bin/bash
# Nested container probes, run as whatever user the agent runs as.
set -u
step() { echo "[diag] === $*"; }
step identity; id; echo "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-}"; cat /proc/self/uid_map
grep -E 'NoNewPrivs|Seccomp:|CapBnd' /proc/self/status
step "env passed"; env | grep -E '^(GH_AW_|RUNNER_TEMP|GITHUB_WORKSPACE|ANTHROPIC_)' | sed 's/=.*KEY.*/=<redacted>/' | cut -c1-120
step "runner home"; ls /home/runner 2>&1 | head -2
step "sudo"; sudo -n true 2>&1 | head -1
step "podman"; podman --version
step "podman run"; timeout 300 podman run --rm quay.io/fedora/fedora:latest sh -c 'cat /proc/self/uid_map; echo NESTED-RUN-OK' 2>&1 | tail -4
step "podman build"
d=$(mktemp -d); printf 'FROM quay.io/fedora/fedora:latest\nRUN useradd -u 2000 bob && touch /f && chown bob /f && ls -ln /f\n' > "$d/Containerfile"
timeout 300 podman build -q -t localhost/spike "$d" 2>&1 | tail -3 && echo NESTED-BUILD-OK
step "kvm"; ls -l /dev/kvm; python3 -c 'import os,fcntl; fd=os.open("/dev/kvm",os.O_RDWR); print("KVM-OK api", fcntl.ioctl(fd,0xAE00))' 2>&1
step "nested kvm"; timeout 120 podman run --rm --device /dev/kvm --group-add keep-groups quay.io/fedora/fedora:latest sh -c 'exec 3<>/dev/kvm && echo NESTED-KVM-OK' 2>&1 | tail -2
step "egress (no AWF here)"; curl -sS -o /dev/null -w '%{http_code}\n' -m 10 https://example.com/ 2>&1
step "mcp gateway reachable"; curl -sS -o /dev/null -w '%{http_code}\n' -m 5 http://127.0.0.1:8080/health 2>&1
step "files"; ls -la /tmp/gh-aw | head -30
