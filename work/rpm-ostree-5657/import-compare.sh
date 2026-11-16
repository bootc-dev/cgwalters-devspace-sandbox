#!/bin/bash
# Run inside uchroot.sh with a harness-patched build at /src: import every RPM
# under /data into /data/out/NAME/repo and list each tree, for diffing builds.
set -euo pipefail
out=/data/out/$1; rm -rf "$out"; mkdir -p "$out/trees"
find /data -name '*.rpm' -not -path '/data/out/*' | sort > "$out/list"
RPMOSTREE_IMPORT_DUMP="$out/list" RPMOSTREE_IMPORT_DUMP_REPO="$out/repo" LC_ALL=C \
  ./rpm-ostree testutils c-units > "$out/results" 2> "$out/stderr"
echo "import took ${SECONDS}s" | tee "$out/time"
while IFS=$'\t' read -r rpm commit; do case $commit in ERROR*) continue;; esac
  ostree --repo="$out/repo" ls -R -X "$commit" > "$out/trees/$(basename "$rpm")"; done < "$out/results"
