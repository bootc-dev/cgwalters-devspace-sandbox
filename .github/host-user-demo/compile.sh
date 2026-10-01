#!/bin/bash
# Compiles aw-host-user.md with a gh-aw binary built from the fork branch.
# The fork's setup action isn't published to github/gh-aw, so the lock file
# is compiled in release mode against the fork commit and its setup action
# references are pointed at the fork; that is the only edit made to the
# generated lock file.
set -euo pipefail
gh_aw=${GH_AW:?set GH_AW to a gh-aw binary built from cgwalters-forge/gh-aw}
sha=${GH_AW_SHA:?set GH_AW_SHA to the cgwalters-forge/gh-aw commit GH_AW was built from}
cd "$(git rev-parse --show-toplevel)"
workflow=${1:-aw-host-user}
"$gh_aw" compile "$workflow" --action-mode release --action-tag "$sha"
lock=.github/workflows/${workflow}.lock.yml
sed -i "s|uses: github/gh-aw/actions/setup@${sha}|uses: cgwalters-forge/gh-aw/actions/setup@${sha}|" "$lock"
if grep -n "github/gh-aw/actions/" "$lock" | grep -v cgwalters-forge | grep -v '^[0-9]*:#'; then
  echo "unexpected references to github/gh-aw actions left" >&2
  exit 1
fi
