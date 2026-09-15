# cgwalters-devspace

This repository provides a manually triggered GitHub Actions workflow for a
bounded, ephemeral RHEL 10 development runner. It provisions the exact
`rhel10-x86_64-16c-64g` runner requested by [infra#257](https://github.com/bootc-dev/infra/issues/257),
joins the bootc-dev tailnet with Tailscale workload identity federation, and
enables Tailscale SSH for Unix user `runner`.

## Prerequisites

An administrator must configure the non-secret repository variables
`TS_OAUTH_CLIENT_ID` and `TS_AUDIENCE`. The Tailscale federated identity must
allow this exact GitHub subject:

```text
repo:bootc-dev@202312630/cgwalters-devspace-sandbox@1372023819:ref:refs/heads/main
```

The Tailscale identity needs writable `auth_keys` scope and the
`tag:bootc-dev-sandbox` tag. Tailnet SSH policy must allow the intended source
identity to reach that tag as OS user `runner`. No repository secret or OAuth
client secret is used.

## Use

Dispatch from `main`, then watch the run:

```console
gh workflow run "Tailscale development runner" --repo bootc-dev/cgwalters-devspace-sandbox \
  --ref main -f duration=30
gh run watch <run-id> --repo bootc-dev/cgwalters-devspace-sandbox
tailscale ssh runner@<hostname-or-IP>
gh run cancel <run-id> --repo bootc-dev/cgwalters-devspace-sandbox
```

The duration choice is 30, 60, or 120 minutes. The job has an independent
125-minute timeout. Cancellation and expiry run the Tailscale action cleanup;
the workflow prints only safe hostname, IPv4, and status information. Treat
the runner as disposable and do not store secrets on it.

If dispatch is unavailable, verify that this workflow is on `main`. If joining
fails, check both repository variables, the federated subject above, the
identity's tag and scope, and device approval. A Tailscale `403 Unauthorized`
from `tailscale up` means the trust credential must be updated to allow the
subject above. The workflow installs `iptables` and links the action's
`/usr/local/bin` binaries into RHEL's sudo path before connecting; these are
required by this runner image. If SSH fails after a successful join, check the
tailnet ACL for the source identity, destination tag, and `runner` OS-user
mapping.
