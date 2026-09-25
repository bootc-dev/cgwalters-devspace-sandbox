# cgwalters-devspace

This repository dispatches a bounded, disposable RHEL 10 development runner.
Tailscale supplies private networking inside the remote workflow; access is
ordinary OpenSSH as user `runner`.

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
it is a nonempty absolute path), dispatches the workflow, and prints the exact
run ID and URL immediately. It then waits until ordinary SSH is ready before
returning. It does not open an SSH session or cancel the runner. `ssh`
repeatedly probes the deterministic MagicDNS hostname
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

The runner hosts [cgwalters-bot](https://github.com/cgwalters-bot) agent
sessions. Before OpenSSH is made available, it automatically installs the bot's
[homegit](https://github.com/cgwalters-bot/homegit) dotfiles, skills, and agent
configuration. Because the runner executes homegit code, it is pinned to the
commit in the `Justfile`'s `homegit_rev`, which Renovate bumps through
reviewed pull requests. The checkout is created at
`$HOME/src/github/cgwalters-bot/homegit` when absent, and existing checkouts
are moved to the pinned commit, fetching it if needed. Interactive users on the
runner therefore get the bot's git identity from its `.gitconfig`.

The opencode and Claude Code agent CLIs are preinstalled globally with npm
(from the RHEL `nodejs` package). Their exact versions are pinned in `npm.txt`,
which Renovate keeps current via the shared bootc-dev configuration. The
GitHub CLI, which the bot's tools call for every GitHub operation, comes from
EPEL. Agent credentials are not provisioned, so `gh` is not logged in.

## TODO / roadmap

- Later, support launching an agent that can work autonomously and push changes
  with safe, scoped credentials, while preserving interactive access.
