# cgwalters-devspace

This repository dispatches a bounded, disposable RHEL 10 development runner.
Tailscale supplies private networking inside the remote workflow; access is
ordinary OpenSSH as the unprivileged user `runner-sandbox`.

## Prerequisites

Install Rust/Cargo 1.85 or newer. The `cargo devspace` alias is defined in this
repository's `.cargo/config.toml` and is local to this checkout. Authenticate
the GitHub CLI (`gh auth login`) with permission to dispatch, view, and cancel
this repository's workflows. The `ssh` and `ssh-keygen` commands must also be
available.

An administrator must configure repository variables `TS_OAUTH_CLIENT_ID` and
`TS_AUDIENCE`. The federated Tailscale identity needs writable `auth_keys`, the
`tag:bootc-dev-sandbox` tag, and network ACL access from your device to that tag
on TCP port 22. No repository secret or OAuth client secret is used.
The client must be connected to the relevant Tailscale network with MagicDNS
access. The Rust tool uses ordinary OpenSSH and does not invoke the local
Tailscale CLI, inspect Tailscale status, or use a local Tailscale socket.

## Use

`cargo devspace` has exactly four commands:

```console
cargo devspace start --duration 240 --cores 16
cargo devspace list
cargo devspace ssh RUN_ID
cargo devspace stop RUN_ID
```

`start` generates an ephemeral Ed25519 key, records it privately under
`${XDG_STATE_HOME:-$HOME/.local/state}/devspace` (using XDG_STATE_HOME only when
it is a nonempty absolute path), dispatches the workflow, and
prints the exact run ID and URL. It does not wait for readiness or cancel the
runner. `ssh` repeatedly probes the deterministic MagicDNS hostname
`cgwalters-devspace-RUN_ID` while the workflow is active, then opens interactive
OpenSSH with that key. `stop` acts only on the given development run and removes
its local key after cancellation or after confirming that the run has already
completed. `list` shows active dispatched-run metadata: run ID, status, title,
and URL.

The duration choices are 30, 60, 120, and 240 minutes (the default); the
workflow's 270-minute timeout allows setup plus the full four-hour lifetime.
Use `--cores 4`, `--cores 16` (the default), or `--cores 64` to select a runner
size. The runner is disposable: do not store secrets on it.
`runner-sizes.json` records the corresponding runner labels.

If dispatch cannot be correlated, the CLI retains the pending private key and
identifies its session so the run can be located manually.

The workflow runs stock `sshd.service`, binds it only to the Tailscale IPv4
address, and enforces a public-key-only configuration. Its keepalive verifies
the service, SELinux context, and bound address every five seconds.

SSH sessions run as `runner-sandbox`, which has no sudo, so builds and tests
started over SSH can't reach the job's credentials. Every workflow step runs as
`runner`, which has passwordless sudo, and the running steps' environments hold
`ACTIONS_ID_TOKEN_REQUEST_TOKEN`; with it, any process of that user could mint
the GitHub OIDC tokens the Tailscale login trusts.
`scripts/setup-runner-sandbox.mjs` creates `runner-sandbox` (in the `kvm` group
and with subordinate IDs, so rootless podman and KVM work; not in `libvirt`,
whose `qemu:///system` access is root-equivalent). That uid separation is the
boundary; otherwise the stock runner setup stays, except for real exposures of
an image built with umask 000: the runner's credentials are world-readable (so
its home directory and `/opt/hca` become private), and system files root loads
code from, such as polkit rules, are world-writable (so world write permission
is removed). `/etc/environment` also loses its `XDG_RUNTIME_DIR`, which pointed
every login at runner's runtime directory; that should be fixed in the runner
image instead
([actions/runner-images#14649](https://github.com/actions/runner-images/issues/14649)).
Workflow steps run commands as `runner-sandbox` through
`scripts/runner-sandbox.mjs`, with `run0`: a login session of its own like an
SSH login's (its own `XDG_RUNTIME_DIR` and systemd user manager, for rootless
podman) and a fixed environment, so nothing of the step's environment comes
along.

On top of that, a sudoers rule denies `runner-sandbox` everything, and so does
a polkit rule (when polkit is installed), which also covers `pkexec`. The
long-running keepalive step re-executes itself without the request token, so
the Tailscale login is its one use (`tailscaled`, which the Tailscale action
starts with `sudo -E`, still has it in its environment, readable only by root),
`ptrace_scope` is 1, Cockpit is off, and `runner-sandbox` can't reach the cloud
metadata service. Nor can it use tailscaled's LocalAPI socket, which is
world-writable and would let any user dial through the node (`tailscale nc`)
and list the tailnet: `/var/run/tailscale` is root's only.
Rootless VMs (`bcvk ephemeral`, `qemu:///session`) work; anything that needs
root must run inside a VM. The toolchain in `packages.txt` is installed before
OpenSSH starts, since sessions can't install packages themselves.

The runner hosts [cgwalters-bot](https://github.com/cgwalters-bot) agent
sessions. Before OpenSSH is made available, it automatically installs the bot's
[homegit](https://github.com/cgwalters-bot/homegit) dotfiles, skills, and agent
configuration for `runner-sandbox`. Because the runner executes homegit code, it is
pinned to the commit in the `Justfile`'s `homegit_rev`, which Renovate bumps through
reviewed pull requests. The checkout is created at
`$HOME/src/github/cgwalters-bot/homegit` when absent, and existing checkouts
are moved to the pinned commit, fetching it if needed. Interactive users on the
devspace therefore get the bot's git identity from its `.gitconfig`.

The opencode and Claude Code agent CLIs are preinstalled globally with npm
(from the RHEL `nodejs` package). Their exact versions are pinned in `npm.txt`,
which Renovate keeps current via the shared bootc-dev configuration. The
GitHub CLI, which the bot's tools call for every GitHub operation, comes from
EPEL. Agent credentials are not provisioned, so `gh` is not logged in.

## Agent runs

`.github/workflows/agent.yml` runs an agent on one task, unattended, as the
same unprivileged `runner-sandbox` user, in a login session of its own, which
`scripts/agent-lib.mjs` kills when the run ends. The job has no secrets; its
`id-token` permission is only for runs that need inference, to join the
tailnet and register with the broker (see below). GitHub puts the variables
that request those OIDC tokens in every step's environment; the agent starts
without them (`scripts/runner-sandbox.mjs`), and the isolation check proves
it. `scripts/agent-isolation-check.mjs` verifies before every run that the
agent can't use sudo, read the job's environment or files, or reach the
cloud metadata service, also from a container on the host network. Its
network access is otherwise open for now, except the tailnet; the plan is a
proxy that sees requests and allows writes (`POST` and the like) only to
known endpoints.

Devspaces and agent runs are for public repositories only: their logs and
transcripts are public. `scripts/public-repo.mjs` refuses a target that
GitHub doesn't confirm is public, failing closed, before anything is cloned
and again before anything is uploaded (`scripts/check-uploads.mjs`).

The agent is driven by `bot-harness` (`harness/`), a client of the
[Agent Client Protocol](https://agentclientprotocol.com) on the
`agent-client-protocol` crate, so no agent is hardcoded: it starts any agent
in `harness/agents.toml` (Claude Code through its ACP adapter, opencode, or
the scripted `fake-acp-agent`) as `runner-sandbox`. It records the protocol
stream, both directions, as `acp.jsonl`, answers the agent's permission
requests from `harness/policy.toml` (recording each decision and its rule),
and cancels the session at the timeout or when the agent goes over budget:
the cost it reports, or a number of tool calls. `bot-harness summary` then
writes `summary.json` and the step summary from the recording, the same way
for every agent.

The condensed transcript streams into the job log in an `agent (condensed)`
group, and the `agent-run` (90 days) and `agent-transcript` (30 days)
artifacts hold the rest, redacted by `agent/redact.mjs` and checked for
anything secret-shaped before upload. A `branch` run that changed files
also uploads `agent-out` (30 days): `changes.patch`, a binary git diff
against the commit in `base.json`. It isn't redacted, so a secret-shaped
string in it fails the upload. The runner can't push, so homegit's
`bot-runs apply` checks the patch again and turns it into a branch on the
forge. The files and the dispatch inputs
follow the
[agent runs contract](https://github.com/cgwalters-bot/homegit/blob/main/docs/devspace-agent-runs.md),
and homegit's `bot-runs` dispatches and reads the runs.

A run offers two agents. `fake` needs no inference: it plays
`harness/fake-agent-demo.json`, using the tools, running into the sandbox
(sudo, the metadata service) and the policy (`git push`), and printing a
token-shaped string for the redaction pass to catch.

`opencode` gets its inference from the
[praxis credential broker](https://github.com/cgwalters-bot/praxis-credential-broker)
on the tailnet, at the `PRAXIS_BASE_URL` repository variable
(`http://<tailnet IPv4>:<port>/v1`). The broker holds the subscription
login, so nothing on the runner holds a model credential. It admits a
request only with the token of a registered run
([run tokens](https://github.com/cgwalters-bot/praxis-credential-broker/blob/main/INTERNALS.md#run-tokens)):
`agent/praxis.mjs register` has the job's supervisor request an OIDC token
for the audience `praxis-credential-broker` and register the run with it
(`POST /v1/runs`, no body), which the broker's `run-token-policy.yaml`
allows only for this repository and workflow, pinned by id, when
dispatched by hand.
The run token it gets back stays in a directory only `runner` can read and
is masked in the log. `praxis.mjs configure` puts it in `runner-sandbox`'s
opencode configuration (`agent/opencode.json`, mode 0600), the only place
the agent gets it; the isolation check proves it's nowhere else the agent
can read. The broker's per-run cap and lifetime then bound what the agent
spends, and nodes with the runners' tag but no registered run get nothing.
`harness/agents.toml` keeps opencode from loading the target repository's
own configuration (which could bring other providers or plugins back).

For these runs the job joins the tailnet as devspaces do, after the same
hardening (sshd stopped, Cockpit off), but without MagicDNS
(`--accept-dns=false`), which would name every node. The tailnet ACL for the
runners' tag is what should limit them to the broker's port; today it
allows more. Underneath it, as defence in depth, `setup-runner-sandbox.mjs
--tailnet-allow` rejects everything `runner-sandbox`'s uids send out of the
Tailscale interface or to a tailnet address (quad-100 and the runner's own
included), except to the broker's address and port, and tailscaled's
LocalAPI is closed to it. There is no per-token
cost, so the `budget` input doesn't apply (`aic_pricing: subscription`):
the broker's per-run cap bounds the run's tokens, and its policy's
`max_secs` and the timeout its time. (`budget` isn't turned into a token
cap: AIC prices tokens, and these have no price.) A broker that refuses
the registration fails the run there, with the policy entry it needs. A
broker from before run tokens, which has no `/v1/runs` (404), is used as
before, without a token and uncapped, with a warning: that keeps runs
working until the broker's cutover, and grants nothing on a broker with
run tokens, which refuses requests without one. When the
agent is done, `run.mjs` ends the praxis run (`DELETE /v1/runs/self`), so
its token admits nothing more, and `bot-harness summary` takes the run's
token counts from the broker's usage record (`--praxis-usage`), into
`summary.json`'s `tokens` and `praxis` fields and the step summary
(`tokens_source: praxis`; counts only the agent reported are marked
`unverified`). An `always()` step ends the run again, whatever happened
before, and nothing is uploaded unless it succeeded: until then the token
may still work.

The harness lives here, next to `agent.yml`, until the
[task harness design](https://gist.github.com/cgwalters-bot/290d1fbd3545e430f7717948caab260f)
settles where tasks and their tools belong.

## TODO / roadmap

- Move the `runner-sandbox` setup into
  [bootc-dev/actions](https://github.com/bootc-dev/actions)' `bootc-host-setup`
  action, on by default, so CI jobs get the same unprivileged user.
- Align `packages.txt` with what `bootc-ubuntu-setup` installs, or switch to a
  devcontainer with the podman socket mounted in.
- Filter agent runs' egress, which is open for now: an L7 proxy that allows
  reads but writes (`POST` and the like) only to listed endpoints, as
  OpenShell's policies do, possibly with a shared denylist
  ([research notes](https://gist.github.com/cgwalters-bot/30ef6cce070d78f60c55284d4c6e6193)).
- Later, support launching an agent that can work autonomously and push changes
  with safe, scoped credentials, while preserving interactive access.
