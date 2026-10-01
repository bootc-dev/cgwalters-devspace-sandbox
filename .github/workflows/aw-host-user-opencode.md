---
description: |
  Demo of gh-aw's sandbox.agent.runtime: host-user (cgwalters-forge/gh-aw fork)
  with the OpenCode engine and inference from the praxis credential broker on
  the tailnet, so no inference credential is on the runner. The agent runs as
  runner-sandbox via run0, runs rootless podman and checks /dev/kvm, then posts
  one comment on issue #12 through safe outputs.

on:
  # The push trigger only exists so GitHub registers this workflow from a
  # non-default branch; the run itself is skipped by the if: below.
  push:
    branches: [bot/gh-aw-host-user]
    paths: [.github/workflows/aw-host-user-opencode.lock.yml]
  workflow_dispatch:

if: github.event_name == 'workflow_dispatch'

permissions:
  contents: read
  issues: read
  id-token: write

runs-on: ubuntu-26.04
timeout-minutes: 30
strict: false

imports:
  - shared/opencode-praxis.md

engine:
  id: opencode
  model: openai/gpt-5.5
  env:
    # praxis (no client auth) holds the upstream credential.
    OPENAI_BASE_URL: http://xenon:18080/v1
    # A non-secret placeholder; it also satisfies the activation secret check.
    OPENAI_API_KEY: unused

sandbox:
  agent:
    runtime: host-user

tools:
  bash: ["*"]
  # checks.sh pulls and builds an image in one call.
  timeout: 600

steps:
  - name: Connect to the tailnet
    uses: tailscale/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8
    with:
      oauth-client-id: ${{ vars.TS_OAUTH_CLIENT_ID }}
      audience: ${{ vars.TS_AUDIENCE }}
      tags: tag:bootc-dev-sandbox
      hostname: cgwalters-awhu-${{ github.run_id }}
  - name: Check that praxis answers
    run: curl -fsS -m 20 http://xenon:18080/healthz
  - name: Install podman
    run: command -v podman >/dev/null || { sudo apt-get update -q && sudo apt-get install -y -q podman >/dev/null; }

safe-outputs:
  add-comment:
    target: "12"
    max: 1
  noop:
    report-as-issue: false
  missing-tool:
    create-issue: false
  missing-data:
    create-issue: false
  report-incomplete:
    create-issue: false
  report-failure-as-issue: false
  threat-detection: false
---

# host-user sandbox demo (OpenCode + praxis)

Run `bash .github/host-user-demo/checks.sh` once with your bash tool. It prints
`CHECK <name>: <result>` lines and can take a few minutes (it pulls and builds
a container image).

Then post exactly one comment on issue #12 with the `add_comment` tool. Start it
with "host-user sandbox demo (OpenCode via praxis), run ${{ github.run_id }}"
and then list every CHECK line as a markdown table (check, result). Add one
sentence on whether anything unexpected showed up. Do nothing else.
