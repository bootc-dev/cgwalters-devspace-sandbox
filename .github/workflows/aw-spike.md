---
description: |
  Research spike: run a gh-aw agent job with a tailscale+sshd side channel so
  a human can inspect the live AWF sandbox and probe nested containers.
  engine.command is replaced by a keepalive script; no inference happens.

on:
  # The push trigger only exists so GitHub registers this workflow from a
  # non-default branch; the run itself is skipped by the if: below.
  push:
    branches: [bot/gh-aw-spike]
    paths: [.github/workflows/aw-spike.lock.yml]
  workflow_dispatch:
    inputs:
      ssh_public_key:
        description: "Single-line Ed25519 public key for OpenSSH"
        type: string
        required: true
      duration:
        description: "Minutes to keep the agent step alive"
        type: choice
        options: ["30", "60"]
        default: "30"

if: github.event_name == 'workflow_dispatch'

permissions:
  contents: read
  id-token: write

runs-on: ubuntu-latest
timeout-minutes: 75

engine:
  id: claude
  command: /tmp/gh-aw/spike/keepalive.sh

network:
  allowed:
    - defaults
    - quay.io
    - "*.quay.io"
    - registry.fedoraproject.org

tools:
  bash: ["*"]

steps:
  - name: Connect to the tailnet
    uses: tailscale/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8
    with:
      oauth-client-id: ${{ vars.TS_OAUTH_CLIENT_ID }}
      audience: ${{ vars.TS_AUDIENCE }}
      tags: tag:bootc-dev-sandbox
      hostname: cgwalters-awspike-${{ github.run_id }}
  - name: Expose sshd on the tailnet and install the keepalive engine
    env:
      SSH_PUBLIC_KEY: ${{ inputs.ssh_public_key }}
      DURATION_MINUTES: ${{ inputs.duration }}
    run: |
      set -euo pipefail
      [[ "$SSH_PUBLIC_KEY" =~ ^ssh-ed25519[[:space:]]+[A-Za-z0-9+/]+={0,2}([[:space:]][^[:cntrl:]]*)?$ ]]
      [[ "$DURATION_MINUTES" =~ ^[0-9]+$ ]]
      command -v sshd >/dev/null || { sudo apt-get update -q && sudo apt-get install -y -q openssh-server; }
      sudo install -d -m 700 -o runner -g runner /home/runner/.ssh
      printf '%s\n' "$SSH_PUBLIC_KEY" | sudo install -m 600 -o runner -g runner /dev/stdin /home/runner/.ssh/spike-authorized_keys
      sudo ssh-keygen -A
      ts_ip=$(sudo tailscale ip -4)
      sudo tee /etc/ssh/sshd_config.d/00-spike.conf >/dev/null <<CONF
      ListenAddress $ts_ip
      AuthorizedKeysFile /home/runner/.ssh/spike-authorized_keys
      AuthenticationMethods publickey
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PermitRootLogin no
      AllowUsers runner
      CONF
      sudo install -d -m 755 /run/sshd
      sudo /usr/sbin/sshd -t
      sudo systemctl stop ssh.socket 2>/dev/null || true
      sudo systemctl restart ssh.service || sudo systemctl restart sshd.service
      sudo ss -ltnp | grep ':22 ' || true
      echo "ssh runner@cgwalters-awspike-${GITHUB_RUN_ID} ($ts_ip)"
      sudo apt-get install -y -q podman tmux >/dev/null 2>&1 || echo "podman install failed" >&2
      mkdir -p /tmp/gh-aw/spike
      cat > /tmp/gh-aw/spike/keepalive.sh <<SCRIPT
      #!/bin/bash
      # Stand-in for the agent CLI: keep the AWF sandbox alive for inspection.
      echo "[spike] keepalive engine pid \$\$ uid \$(id -u) args: \$*" >&2
      end=\$(( \$(date +%s) + ${DURATION_MINUTES} * 60 ))
      while [ "\$(date +%s)" -lt "\$end" ] && [ ! -e /tmp/gh-aw/spike/stop ]; do
        echo '{"type":"system","subtype":"spike-keepalive"}'
        sleep 60
      done
      exit 0
      SCRIPT
      chmod 755 /tmp/gh-aw/spike/keepalive.sh
---

# Spike

This workflow does not perform inference; the engine command is a keepalive.
