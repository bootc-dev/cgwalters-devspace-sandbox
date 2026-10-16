#!/bin/bash
# setup.script of rhel10-kvm-smoke.toml: run by `sandbox setup` as the
# sandbox user, after the network rules, with the agent's environment. It
# proves that this user can boot a VM through qemu:///session with passt
# networking and reach it over ssh, which is what a bootc agent run needs.
set -euo pipefail

readonly IMAGE_URL=https://cloud.centos.org/centos/10-stream/x86_64/images/CentOS-Stream-GenericCloud-10-latest.x86_64.qcow2
readonly NAME=kvm-smoke
readonly SSH_PORT=2222
readonly BOOT_TIMEOUT=300

id
ls -lZ /dev/kvm
test -r /dev/kvm -a -w /dev/kvm || { echo "error: /dev/kvm is not usable by $(id -un)" >&2; exit 1; }

work=$(mktemp -d)
cleanup() {
    virsh --connect qemu:///session destroy "$NAME" >/dev/null 2>&1 || :
    virsh --connect qemu:///session undefine --nvram "$NAME" >/dev/null 2>&1 || :
    rm -rf "$work"
}
trap cleanup EXIT

curl -fsSL --retry 3 --max-time 600 -o "$work/base.qcow2" "$IMAGE_URL"
qemu-img create -q -f qcow2 -F qcow2 -b "$work/base.qcow2" "$work/disk.qcow2" 10G
ssh-keygen -q -t ed25519 -N '' -f "$work/key"

timeout 120 virt-install --connect qemu:///session \
    --name "$NAME" --memory 2048 --vcpus 2 --import \
    --osinfo detect=on,require=off \
    --disk "path=$work/disk.qcow2,format=qcow2" \
    --network "passt,portForward=${SSH_PORT}:22" \
    --cloud-init "root-ssh-key=$work/key.pub" \
    --graphics none --noautoconsole

ssh_opts=(-i "$work/key" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
    -o ConnectTimeout=5 -o BatchMode=yes)
deadline=$((SECONDS + BOOT_TIMEOUT))
until ssh "${ssh_opts[@]}" root@127.0.0.1 'uname -a; . /etc/os-release; echo "$PRETTY_NAME"'; do
    if ((SECONDS >= deadline)); then
        echo "error: no ssh to the VM on port ${SSH_PORT} after ${BOOT_TIMEOUT}s" >&2
        virsh --connect qemu:///session dominfo "$NAME" >&2 || :
        tail -n 50 ~/.cache/libvirt/qemu/log/"$NAME".log >&2 || :
        exit 1
    fi
    sleep 5
done
echo "kvm-smoke: booted a VM as $(id -un) and reached it over ssh on port ${SSH_PORT}"
