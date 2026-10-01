---
description: |
  Spike probe: does a stock gh-aw (AWF) agent job start on the RHEL 10
  runner labels? No tailscale; the engine command is a no-op.

on:
  push:
    branches: [bot/gh-aw-spike]
    paths: [.github/workflows/aw-rhel.lock.yml]
  workflow_dispatch:

if: github.event_name == 'workflow_dispatch'

permissions:
  contents: read

runs-on: rhel10-x86_64-4c-16g
timeout-minutes: 20

engine:
  id: claude
  command: /bin/true

safe-outputs:
  report-failure-as-issue: false
  noop:

steps:
  - name: Probe container tooling
    run: |
      cat /etc/os-release | head -2; systemctl --version | head -1
      command -v docker && docker version || echo "no docker"
      command -v podman && podman --version || echo "no podman"
      rpm -q podman-docker moby-engine docker-ce 2>&1 || true
---

# Probe

Call noop.
