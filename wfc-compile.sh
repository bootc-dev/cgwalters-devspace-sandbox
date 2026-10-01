#!/bin/bash
# Compile workflows/*.ncl to .github/workflows/*.lock.yml with wfc from
# cgwalters-forge/workflow-compiler at the commit in .wfc-rev, checked out
# in ./wfc, where the sources import its library from. Then check them.
# Run it on a devspace (it builds wfc with cargo).
set -euo pipefail
cd "$(dirname "$0")"
rev=$(cat .wfc-rev)
if [ ! -d wfc/.git ]; then
  git init -q wfc
fi
git -C wfc fetch -q --depth 1 https://github.com/cgwalters-forge/workflow-compiler "$rev"
git -C wfc -c advice.detachedHead=false checkout -q FETCH_HEAD
test "$(git -C wfc rev-parse HEAD)" = "$rev"
cargo run -q --manifest-path wfc/Cargo.toml -- compile --root .
cargo run -q --manifest-path wfc/Cargo.toml -- check --root . --runtime wfc/runtime
