#!/bin/bash
# Spike stand-in for a forked gh-aw compiler's generated "enter the sandbox"
# step (modelled on workflow-compiler's secure-host.cjs + install.cjs).
# Runs as root after gh-aw's privileged setup (MCP gateway already started
# by runner via docker) and before the agent step.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "must run as root" >&2; exit 1; }
SBX="runner-sandbox"
runner=${SUDO_USER:?run with sudo from the runner user}
: "${RUNNER_TEMP:?}" "${GITHUB_WORKSPACE:?}"
command -v run0 >/dev/null || { echo "run0 missing (needs systemd >= 256)" >&2; exit 1; }

# secure-host (subset): close runner's home, no ptrace across same uid.
chmod 700 "/home/$runner"
echo 1 > /proc/sys/kernel/yama/ptrace_scope

getent passwd "$SBX" >/dev/null || useradd --create-home --user-group --shell /bin/bash "$SBX"
grep -q "^$SBX:" /etc/subuid || usermod --add-subuids 200000-265535 --add-subgids 200000-265535 "$SBX"
# /dev/kvm: on ubuntu it is root:kvm 0660; devenv makes it 0666 instead.
getent group kvm >/dev/null && usermod -aG kvm "$SBX"
printf '%s ALL=(ALL:ALL) !ALL\n' "$SBX" > /etc/sudoers.d/zz-runner-sandbox
chmod 440 /etc/sudoers.d/zz-runner-sandbox
visudo -cq -f /etc/sudoers.d/zz-runner-sandbox

# Hand-off. gh-aw keeps its scripts and the MCP client config under
# $RUNNER_TEMP (inside runner's now-closed home): give the sandbox a
# root-owned read-only copy at a fixed path.
base=/var/lib/runner-sandbox
install -d -m 755 "$base" "$base/temp"
install -d -m 755 -o "$SBX" -g "$SBX" "$base/work"
rm -rf "$base/temp/gh-aw"
mkdir -p "$base/temp/gh-aw"
cp -a "$RUNNER_TEMP/gh-aw/actions" "$base/temp/gh-aw/"
cp -a "$RUNNER_TEMP/gh-aw/mcp-config" "$base/temp/gh-aw/" 2>/dev/null || true
chown -R root:root "$base/temp/gh-aw"
chmod -R a+rX,go-w "$base/temp/gh-aw"
# Workspace: tracked files only, like wfc's handoff 'tracked.
runuser -u "$runner" -- git -C "$GITHUB_WORKSPACE" ls-files -z |
  (cd "$GITHUB_WORKSPACE" && cpio -0 -pdm --quiet "$base/work")
chown -R "$SBX:$SBX" "$base/work"
# /tmp/gh-aw is gh-aw's agent<->runner exchange directory; the sandbox gets
# it bind-mounted into its private /tmp. Files gh-aw pre-created as runner
# with umask 177 are not writable by the sandbox, so open the ones the
# agent step writes.
chmod 1777 /tmp/gh-aw
for f in /tmp/gh-aw/agent-step-summary.md /tmp/gh-aw/claude-debug.log; do
  [ -e "$f" ] && chmod 666 "$f"
done

install -m 755 "$GITHUB_WORKSPACE/.github/spike/sandbox-run" /usr/local/libexec/spike-sandbox-run
# Like wfc: runner may run the wrapper as root (spike: runner keeps full
# sudo so the human on ssh can still administer the VM).
loginctl disable-linger "$SBX" || true
echo "sandbox ready: $(id "$SBX")"
