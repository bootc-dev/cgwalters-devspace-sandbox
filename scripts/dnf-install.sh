#!/bin/bash
# dnf install, retried: the RHUI mirrors time out now and then, and one
# timeout would otherwise fail the whole run. Usage: dnf-install.sh ARGS...
# (dnf install's own options and packages). In shell, since it runs before
# Node is installed.
set -euo pipefail
readonly ATTEMPTS=4 PAUSE=20
for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  sudo dnf install -y "$@" && exit 0
  echo "::warning::dnf install failed (attempt ${attempt} of ${ATTEMPTS})"
  # A half-fetched repository index isn't used again.
  sudo dnf clean expire-cache || true
  sleep $((attempt * PAUSE))
done
echo "::error::dnf install failed ${ATTEMPTS} times: $*"
exit 1
