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

## TODO / roadmap

- Move the `runner-sandbox` setup into
  [bootc-dev/actions](https://github.com/bootc-dev/actions)' `bootc-host-setup`
  action, on by default, so CI jobs get the same unprivileged user.
- Align `packages.txt` with what `bootc-ubuntu-setup` installs, or switch to a
  devcontainer with the podman socket mounted in.
- Later, support launching an agent that can work autonomously and push changes
  with safe, scoped credentials, while preserving interactive access.
