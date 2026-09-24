# renovate: datasource=git-refs depName=https://github.com/cgwalters-bot/homegit branch=main
homegit_rev := "23d5662ff24e7aef8abb73ecfa7b1fa8cb9395c4"

# Install the bot's dotfiles from the pinned homegit revision.
init:
    #!/usr/bin/env bash
    set -euo pipefail
    # The Actions runner uses umask 000, and homegit installs dotfiles with
    # rsync without preserving permissions; keep them from being world-writable.
    umask 022
    readonly homegit_url=https://github.com/cgwalters-bot/homegit.git
    readonly homegit_rev="{{homegit_rev}}"
    readonly homegit="$HOME/src/github/cgwalters-bot/homegit"
    if [[ ! -e "$homegit" && ! -L "$homegit" ]]; then
    mkdir -p "$(dirname "$homegit")"
    git clone "$homegit_url" "$homegit"
    else
    root="$(git -C "$homegit" rev-parse --show-toplevel 2>/dev/null || true)"
    origin="$(git -C "$homegit" remote get-url origin 2>/dev/null || true)"
    if [[ "$root" != "$homegit" || "$origin" != "$homegit_url" ]]; then
    printf 'refusing to use path that is not the expected homegit checkout: %s\n' "$homegit" >&2
    exit 1
    fi
    fi
    if ! git -C "$homegit" cat-file -e "$homegit_rev^{commit}" 2>/dev/null; then
    git -C "$homegit" fetch origin "$homegit_rev"
    fi
    git -C "$homegit" checkout --quiet --detach "$homegit_rev"
    make -C "$homegit" install
    # Also repair anything created before the umask was set, including the
    # runner image's own ~/.bash_profile and ~/.bash_logout.
    chmod -R go-w "$homegit" "$HOME/.local/bin"
    (cd "$homegit/dotfiles" && find . -mindepth 1 ! -type l -print0) | (cd "$HOME" && xargs -0 chmod go-w --)
    find "$HOME" -maxdepth 1 -name '.*' ! -type l -perm /go+w -exec chmod go-w {} +
