#!/bin/bash
# Usage: bash vssh.sh SSHPORT COMMAND...
port=$1; shift
exec ssh -q -i "${VM_SSH_KEY:-/var/tmp/w/ssh/id}" -p "$port" -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes root@127.0.0.1 "$@"
