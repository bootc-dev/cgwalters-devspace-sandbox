# Install the user's dotfiles without updating an existing checkout.
init:
    #!/usr/bin/env bash
    set -euo pipefail
    homegit="$HOME/src/github/cgwalters/homegit"
    if [[ ! -e "$homegit" && ! -L "$homegit" ]]; then
    mkdir -p "$(dirname "$homegit")"
    git clone https://github.com/cgwalters/homegit.git "$homegit"
    else
    root="$(git -C "$homegit" rev-parse --show-toplevel 2>/dev/null || true)"
    origin="$(git -C "$homegit" remote get-url origin 2>/dev/null || true)"
    if [[ "$root" != "$homegit" || "$origin" != https://github.com/cgwalters/homegit.git ]]; then
    printf 'refusing to use path that is not the expected homegit checkout: %s\n' "$homegit" >&2
    exit 1
    fi
    fi
    make -C "$homegit" install
