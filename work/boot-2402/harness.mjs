// Test harness for bootc-dev/bootc#2402: how /boot is mounted on image-based
// Fedora/CentOS hosts, and whether an update survives the /boot automount
// idling out. See README.md. Node.js standard library only; drives qemu-kvm
// directly and does all root work (podman, bootc install) in a builder VM.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';

const STATE = path.resolve(process.env.B2402_STATE ?? '/var/tmp/b2402');
const QEMU = process.env.QEMU ?? '/usr/libexec/qemu-kvm';
const OVMF_CODE = process.env.OVMF_CODE ?? '/usr/share/edk2/ovmf/OVMF_CODE.fd';
const OVMF_VARS = process.env.OVMF_VARS ?? '/usr/share/edk2/ovmf/OVMF_VARS.fd';
// The egress proxy of the agent sandbox intercepts TLS; VMs must trust its CA.
const EXTRA_CA = process.env.B2402_EXTRA_CA ?? '/etc/egress-proxy/ca.pem';

const FEDORA = '45';
const FEDORA_URL = `https://download.fedoraproject.org/pub/fedora/linux/releases/${FEDORA}`;
const DOWNLOADS = {
  'cloud.qcow2': `${FEDORA_URL}/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-${FEDORA}-1.4.x86_64.qcow2`,
  'silverblue.iso': `${FEDORA_URL}/Silverblue/x86_64/iso/Fedora-Silverblue-Installer-${FEDORA}-1.4.x86_64.iso`,
};
// The F45 installer ISO (built by image-builder) carries an ostree repo in its
// root filesystem; a user kickstart replaces interactive-defaults.ks, so it
// has to name the payload itself.
const SILVERBLUE_PAYLOAD =
  `ostreesetup --osname=fedora --url=file:///ostree/repo --ref=fedora/${FEDORA}/x86_64/silverblue --remote=fedora --nogpg`;

const OSTREE_REPO = 'https://github.com/ostreedev/ostree';
const OSTREE_PR = '3690';

const BOOTC_IMAGES = {
  'fedora-bootc-45': 'quay.io/fedora/fedora-bootc:45',
  'fedora-bootc-44': 'quay.io/fedora/fedora-bootc:44',
  'centos-bootc-10': 'quay.io/centos-bootc/centos-bootc:stream10',
};
const DEFAULT_BOOTC_IMAGES = ['fedora-bootc-45', 'centos-bootc-10'];
const VARIANTS = ['stock', `pr${OSTREE_PR}`];

// GPT partition type GUIDs (Discoverable Partitions Specification).
const GPT = {
  biosBoot: '21686148-6449-6E6F-744E-656564454649',
  esp: 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B',
  linux: '0FC63DAF-8483-4772-8E79-3D69D8477DE4',
  xbootldr: 'BC13C2FF-59E6-4262-A352-B275FD6F7172',
  rootX86_64: '4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709',
};

// bootc layouts. boot: 'root' (/boot on the root filesystem, installed with
// `bootc install to-disk`), 'part' (separate ext4 /boot, generic Linux type)
// or 'xbootldr' (separate ext4 /boot typed XBOOTLDR), both installed with
// `to-filesystem`. efiDir adds an empty /efi to the image. fstab lists the
// entries the installed /etc/fstab ends up with ('boot', 'esp:<path>');
// everything else for /boot, /boot/efi and /efi is removed.
const BOOTC_LAYOUTS = {
  'root': { boot: 'root', fstab: [], firmware: ['uefi', 'bios'] },
  'root-efidir': { boot: 'root', efiDir: true, fstab: [] },
  'root-fstab-esp': { boot: 'root', fstab: ['esp:/boot/efi'] },
  'part-fstab': { boot: 'part', fstab: ['boot'], firmware: ['uefi', 'bios'] },
  'part-fstab-esp': { boot: 'part', fstab: ['boot', 'esp:/boot/efi'] },
  'part-nofstab': { boot: 'part', fstab: [] },
  'xbootldr-fstab': { boot: 'xbootldr', fstab: ['boot'] },
  'xbootldr-nofstab': { boot: 'xbootldr', fstab: [] },
  'xbootldr-efidir-nofstab': { boot: 'xbootldr', efiDir: true, fstab: [] },
};

// Silverblue layouts, installed from the ISO with a kickstart. drop lists the
// fstab mount points %post removes from what Anaconda wrote.
const SILVERBLUE_LAYOUTS = {
  'sb-default': { parts: 'autopart --noswap --type=btrfs', drop: [] },
  'sb-default-nofstab-boot': { parts: 'autopart --noswap --type=btrfs', drop: ['/boot'] },
  'sb-default-nofstab-esp': { parts: 'autopart --noswap --type=btrfs', drop: ['/boot/efi'] },
  'sb-default-nofstab': { parts: 'autopart --noswap --type=btrfs', drop: ['/boot', '/boot/efi'] },
  // A bare btrfs partition as / fails to mount in Anaconda (it expects
  // subvolumes), so these use xfs.
  'sb-noboot': { parts: 'part /boot/efi --fstype=efi --size=600\npart / --fstype=xfs --grow', drop: [] },
  'sb-noboot-nofstab': { parts: 'part /boot/efi --fstype=efi --size=600\npart / --fstype=xfs --grow', drop: ['/boot/efi'] },
};

const BUILDER_DIR = path.join(STATE, 'builder');
const DISKS_DIR = path.join(STATE, 'disks');
const RUNS_DIR = path.join(STATE, 'runs');
const SSH_KEY = path.join(STATE, 'ssh', 'id_ed25519');
const NEXT_MARKER = '/usr/share/b2402/next';
// gpt-auto-generator hardcodes TimeoutIdleSec=120; wait comfortably past it.
const IDLE_WAIT_S = 240;

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
const ts = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function log(tag, msg) {
  console.log(`${ts()} [${tag}] ${msg}`);
}

// Run a command; resolves {code, out, err}. Rejects on nonzero exit unless
// check is false.
function sh(cmd, args, { input, check = true, timeoutS, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = timeoutS && setTimeout(() => p.kill('SIGKILL'), timeoutS * 1000);
    p.on('error', reject);
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      const r = { code: code ?? (signal ? 128 : -1), out, err };
      if (check && r.code !== 0) {
        reject(new Error(`${cmd} ${args.join(' ').slice(0, 300)}: exit ${r.code}\n${(err || out).slice(-3000)}`));
      } else {
        resolve(r);
      }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function ensureSshKey() {
  if (!fs.existsSync(SSH_KEY)) {
    fs.mkdirSync(path.dirname(SSH_KEY), { recursive: true });
    await sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'b2402-harness', '-f', SSH_KEY]);
  }
  return fs.readFileSync(`${SSH_KEY}.pub`, 'utf8').trim();
}

function extraCa() {
  return fs.existsSync(EXTRA_CA) ? fs.readFileSync(EXTRA_CA, 'utf8') : null;
}

const SSH_OPTS = () => [
  '-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes',
  '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=6',
];

class Vm {
  // disks: [{file, format?, serial?}]; cdroms: [file]; firmware: uefi|bios;
  // varsFrom: an OVMF vars file to start from (keeps installer boot entries).
  constructor(name, dir, opts) {
    this.name = name;
    this.dir = dir;
    this.opts = { cpus: 2, memMiB: 3072, firmware: 'uefi', disks: [], cdroms: [], ...opts };
  }

  async start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.port = await freePort();
    const o = this.opts;
    const args = [
      '-name', this.name, '-machine', 'q35,accel=kvm', '-cpu', 'host',
      '-smp', String(o.cpus), '-m', String(o.memMiB),
      '-display', 'none', '-vga', 'none', '-monitor', 'none',
      '-serial', `file:${path.join(this.dir, 'serial.log')}`,
      '-netdev', `user,id=n0,hostfwd=tcp:127.0.0.1:${this.port}-:22`,
      '-device', 'virtio-net-pci,netdev=n0',
      '-device', 'virtio-rng-pci',
    ];
    if (o.firmware === 'uefi') {
      const vars = path.join(this.dir, 'OVMF_VARS.fd');
      fs.copyFileSync(o.varsFrom ?? OVMF_VARS, vars);
      this.varsFile = vars;
      args.push('-drive', `if=pflash,format=raw,unit=0,readonly=on,file=${OVMF_CODE}`,
        '-drive', `if=pflash,format=raw,unit=1,file=${vars}`);
    }
    o.disks.forEach((d, i) => {
      args.push('-drive', `file=${d.file},if=none,id=d${i},format=${d.format ?? 'qcow2'},cache=unsafe,discard=unmap`,
        '-device', `virtio-blk-pci,drive=d${i},serial=${d.serial ?? `disk${i}`}${i === 0 && !o.kernel ? ',bootindex=1' : ''}`);
    });
    o.cdroms.forEach((f, i) => {
      args.push('-drive', `file=${f},if=none,id=cd${i},media=cdrom,readonly=on`, '-device', `ide-cd,drive=cd${i},bus=ide.${i}`);
    });
    if (o.kernel) args.push('-kernel', o.kernel, '-initrd', o.initrd, '-append', o.append);
    // systemd's tmpfiles.d/provision.conf installs this as root's
    // authorized_keys (with the right SELinux label) when it is missing.
    const key = Buffer.from(fs.readFileSync(`${SSH_KEY}.pub`)).toString('base64');
    args.push('-smbios', `type=11,value=io.systemd.credential.binary:ssh.authorized_keys.root=${key}`);
    if (o.noReboot) args.push('-no-reboot');
    const logFd = fs.openSync(path.join(this.dir, 'qemu.log'), 'a');
    this.proc = spawn(QEMU, args, { stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);
    this.exited = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)));
    this.proc.on('exit', () => (this.dead = true));
    fs.writeFileSync(path.join(this.dir, 'qemu.cmdline'), [QEMU, ...args].map(q).join(' ') + '\n');
    log(this.name, `started qemu pid ${this.proc.pid}, ssh port ${this.port}`);
  }

  ssh(script, { check = true, timeoutS = 1800 } = {}) {
    return sh('ssh', [...SSH_OPTS(), '-p', String(this.port), 'root@127.0.0.1', 'bash -s'],
      { input: script, check, timeoutS });
  }

  scpTo(local, remote) {
    return sh('scp', [...SSH_OPTS(), '-P', String(this.port), local, `root@127.0.0.1:${remote}`], { timeoutS: 3600 });
  }

  scpFrom(remote, local) {
    return sh('scp', [...SSH_OPTS(), '-P', String(this.port), `root@127.0.0.1:${remote}`, local], { timeoutS: 3600 });
  }

  serialSize() {
    const f = path.join(this.dir, 'serial.log');
    return fs.existsSync(f) ? fs.statSync(f).size : 0;
  }

  // Console output since the given offset.
  serialSince(offset) {
    const f = path.join(this.dir, 'serial.log');
    return fs.existsSync(f) ? fs.readFileSync(f).subarray(offset).toString('utf8') : '';
  }

  async waitSsh(timeoutS = 600, serialOffset = this.serialSize()) {
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
      if (this.dead) throw new Error(`${this.name}: qemu exited while waiting for ssh`);
      if (/You are in emergency mode|Cannot open access to console/.test(this.serialSince(serialOffset))) {
        throw new Error('boots to emergency mode (see serial.log)');
      }
      const r = await this.ssh('cat /proc/sys/kernel/random/boot_id', { check: false, timeoutS: 30 });
      if (r.code === 0) return r.out.trim();
      await sleep(3);
    }
    throw new Error(`${this.name}: ssh not reachable after ${timeoutS}s (see ${this.dir}/serial.log)`);
  }

  async reboot(timeoutS = 900) {
    const before = (await this.ssh('cat /proc/sys/kernel/random/boot_id')).out.trim();
    const offset = this.serialSize();
    await this.ssh('systemctl reboot', { check: false, timeoutS: 30 });
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
      await sleep(5);
      if (this.dead) throw new Error(`${this.name}: qemu exited during reboot`);
      if (/You are in emergency mode|Cannot open access to console/.test(this.serialSince(offset))) {
        throw new Error('rebooted into emergency mode (see serial.log)');
      }
      const r = await this.ssh('cat /proc/sys/kernel/random/boot_id', { check: false, timeoutS: 30 });
      if (r.code === 0 && r.out.trim() !== before) return;
    }
    throw new Error(`${this.name}: did not come back from reboot within ${timeoutS}s`);
  }

  async stop() {
    if (this.dead) return;
    await this.ssh('systemctl poweroff', { check: false, timeoutS: 30 });
    const t = await Promise.race([this.exited, sleep(180).then(() => 'timeout')]);
    if (t === 'timeout') {
      this.proc.kill('SIGKILL');
      await this.exited;
    }
  }
}

async function qemuImg(...args) {
  await sh('qemu-img', args);
}

// --- downloads -------------------------------------------------------------

async function cmdFetch() {
  const dl = path.join(STATE, 'dl');
  fs.mkdirSync(dl, { recursive: true });
  for (const [name, url] of Object.entries(DOWNLOADS)) {
    const dest = path.join(dl, name);
    if (fs.existsSync(dest)) continue;
    log('fetch', `${url}`);
    await sh('curl', ['-fsSL', '-o', `${dest}.tmp`, url], { timeoutS: 3600 });
    fs.renameSync(`${dest}.tmp`, dest);
  }
}

// --- builder VM --------------------------------------------------------------

function seedIso(dir, pubkey) {
  const ca = extraCa();
  const userData = [
    '#cloud-config',
    'disable_root: false',
    'write_files:',
    '  - path: /root/.ssh/authorized_keys',
    '    permissions: "0600"',
    `    content: ${JSON.stringify(pubkey + '\n')}`,
    ...(ca ? ['  - path: /etc/pki/ca-trust/source/anchors/b2402-extra.pem',
      `    content: ${JSON.stringify(ca)}`] : []),
    'runcmd:',
    '  - [update-ca-trust]',
    '  - [restorecon, -R, /root/.ssh]',
  ].join('\n') + '\n';
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'user-data'), userData);
  fs.writeFileSync(path.join(seed, 'meta-data'), 'instance-id: b2402-builder\nlocal-hostname: b2402-builder\n');
  const iso = path.join(dir, 'seed.iso');
  return sh('mkisofs', ['-quiet', '-o', iso, '-V', 'cidata', '-J', '-r', seed]).then(() => iso);
}

const BUILDER_PACKAGES = 'podman skopeo git-core rpm-build dosfstools xfsprogs e2fsprogs util-linux jq';

// Boot the builder with the given target disks attached (serial t0, t1, ...)
// and run fn(vm). The builder's root disk persists, caching container images.
async function withBuilder(targets, fn) {
  await cmdFetch();
  const pubkey = await ensureSshKey();
  fs.mkdirSync(BUILDER_DIR, { recursive: true });
  const root = path.join(BUILDER_DIR, 'root.qcow2');
  if (!fs.existsSync(root)) {
    await qemuImg('create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', path.join(STATE, 'dl', 'cloud.qcow2'), root, '300G');
  }
  const iso = await seedIso(BUILDER_DIR, pubkey);
  const vm = new Vm('builder', path.join(BUILDER_DIR, 'vm'), {
    cpus: 16, memMiB: 32768,
    disks: [{ file: root }, ...targets.map((file, i) => ({ file, serial: `t${i}` }))],
    cdroms: [iso],
  });
  await vm.start();
  try {
    await vm.waitSsh(900);
    await vm.ssh(`cloud-init status --wait >/dev/null || true
test -e /var/b2402/.provisioned && exit 0
dnf -y -q install ${BUILDER_PACKAGES}
mkdir -p /var/b2402 && touch /var/b2402/.provisioned`, { timeoutS: 3600 });
    await vm.scpTo(`${SSH_KEY}.pub`, '/var/b2402/authorized_keys');
    await vm.ssh(`cp ${CA_BUNDLE} /var/b2402/ca-bundle.pem`);
    return await fn(vm);
  } finally {
    await vm.stop();
  }
}

// podman invocation for bootc install, per the bootc documentation.
const PODMAN_INSTALL = 'podman run --rm --privileged --pid=host --security-opt label=type:unconfined_t ' +
  '-v /dev:/dev -v /var/lib/containers:/var/lib/containers -v /var/b2402:/var/b2402:ro';
const INSTALL_ARGS = '--generic-image --root-ssh-authorized-keys /var/b2402/authorized_keys --karg console=ttyS0,115200';
// Bind the builder's CA bundle (which trusts the sandbox's egress proxy) over
// the image's for networked container steps.
const CA_BUNDLE = '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem';
const CA_MOUNT = `-v /var/b2402/ca-bundle.pem:${CA_BUNDLE}:ro,Z`;

const imageTag = (image, variant, efiDir) => `localhost/b2402:${image}-${variant}${efiDir ? '-efidir' : ''}`;
const nextTag = (tag) => tag.replace('localhost/b2402:', 'localhost/b2402-next:');
const nextArchive = (image, variant, efiDir) => path.join(STATE, 'next', `${image}-${variant}${efiDir ? '-efidir' : ''}.ociarchive`);

// Build RPMs of the distribution's own ostree source package with the
// upstream PR's commits added as patches, inside the base image itself so
// the build matches the shipped version and its dependencies.
async function buildPatchedOstree(vm, image) {
  const out = `/var/b2402/rpms/${image}`;
  const r = await vm.ssh(`ls ${out}/ostree-libs-*.rpm 2>/dev/null | head -1`, { check: false });
  if (r.out.trim()) return;
  await vm.ssh(`set -euo pipefail
cd /var/b2402
if ! test -d ostree.git; then git clone -q --bare --filter=blob:none ${OSTREE_REPO} ostree.git; fi
git -C ostree.git fetch -q origin main pull/${OSTREE_PR}/head:pr${OSTREE_PR}
rm -rf patches-pr${OSTREE_PR} && mkdir patches-pr${OSTREE_PR}
base=$(git -C ostree.git merge-base main pr${OSTREE_PR})
git -C ostree.git format-patch -q -o /var/b2402/patches-pr${OSTREE_PR} $base..pr${OSTREE_PR}
git -C ostree.git rev-parse pr${OSTREE_PR} > patches-pr${OSTREE_PR}/HEAD`, { timeoutS: 1800 });
  const script = `set -euxo pipefail
if command -v dnf5; then dnf -y -q install rpm-build dnf5-plugins; else dnf -y -q install rpm-build 'dnf-command(builddep)' 'dnf-command(download)'; fi
cd /tmp
dnf -y -q download --srpm ostree 2>/dev/null || dnf -y -q download --source ostree
# /root is a dangling symlink to /var/roothome in bootc images.
top=/tmp/rpmbuild
rpm -i --define "_topdir $top" ostree-*.src.rpm
cd $top/SPECS
grep -q '^%autosetup' ostree.spec
n=9000
# Commits that only add tests touch files the release tarball doesn't ship.
for p in /patches/0*.patch; do case $p in *-tests-*) continue;; esac; n=$((n+1)); cp $p ../SOURCES/; sed -i "/^Source0:/a Patch$n: $(basename $p)" ostree.spec; done
# Some of ostree's build dependencies are in CRB on CentOS Stream.
dnf -y -q builddep $(command -v dnf5 >/dev/null || echo --enablerepo=crb) ostree.spec
rpmbuild -bb --nocheck --define "_topdir $top" --define "dist $(rpm --eval %dist).b2402" ostree.spec
cp $top/RPMS/*/ostree-[0-9]*.rpm $top/RPMS/*/ostree-libs-[0-9]*.rpm $top/RPMS/*/ostree-grub2-[0-9]*.rpm /out/ 2>/dev/null || true
ls /out/ostree-libs-*.rpm`;
  log('builder', `building ostree with PR ${OSTREE_PR} for ${image}`);
  await vm.ssh(`set -euo pipefail
mkdir -p ${out}
podman run --rm --network=host ${CA_MOUNT} -v /var/b2402/patches-pr${OSTREE_PR}:/patches:ro,Z -v ${out}:/out:Z ${BOOTC_IMAGES[image]} bash -c ${q(script)} > ${out}.log 2>&1 || { tail -50 ${out}.log; exit 1; }`, { timeoutS: 3600 });
}

// Pull the base image and build the derived image a disk is installed from,
// plus the "next" image the update switches to (saved as an OCI archive).
async function ensureImages(vm, image, variant, efiDir) {
  const tag = imageTag(image, variant, efiDir);
  const archive = nextArchive(image, variant, efiDir);
  const have = await vm.ssh(`podman image exists ${q(tag)}`, { check: false });
  if (have.code === 0 && fs.existsSync(archive)) return tag;
  const patched = variant !== 'stock';
  if (patched) await buildPatchedOstree(vm, image);
  const containerfile = [
    `FROM ${BOOTC_IMAGES[image]}`,
    ...(efiDir ? ['RUN mkdir /efi'] : []),
    ...(patched ? [`RUN --mount=type=bind,source=rpms/${image},target=/rpms rpm -Fvh --nosignature /rpms/*.rpm && rpm -q ostree | grep b2402`] : []),
  ].join('\n');
  const next = `FROM ${tag}\nRUN mkdir -p ${path.dirname(NEXT_MARKER)} && echo ${q(tag)} > ${NEXT_MARKER}`;
  const remoteArchive = `/var/b2402/next-${path.basename(archive)}`;
  log('builder', `building ${tag}`);
  await vm.ssh(`set -euo pipefail
cd /var/b2402
podman pull -q ${BOOTC_IMAGES[image]} >/dev/null
printf '%s\\n' ${q(containerfile)} > Containerfile.build
podman build -q -f Containerfile.build -t ${q(tag)} . >/dev/null
printf '%s\\n' ${q(next)} > Containerfile.next
podman build -q -f Containerfile.next -t ${q(nextTag(tag))} . >/dev/null
rm -f ${remoteArchive}
podman save -q --format oci-archive -o ${remoteArchive} ${q(nextTag(tag))}`, { timeoutS: 3600 });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  await vm.scpFrom(remoteArchive, `${archive}.tmp`);
  fs.renameSync(`${archive}.tmp`, archive);
  await vm.ssh(`rm -f ${remoteArchive}`);
  return tag;
}

// Installs to different disks run in parallel; give each its own mount point.
const mountDir = (dev) => `/mnt/${path.basename(dev)}`;

function partitionScript(dev, bootType) {
  const mnt = mountDir(dev);
  const table = [
    'label: gpt',
    `size=1MiB, type=${GPT.biosBoot}, name=BIOS-BOOT`,
    `size=600MiB, type=${GPT.esp}, name=EFI-SYSTEM`,
    `size=1GiB, type=${bootType}, name=boot`,
    `type=${GPT.rootX86_64}, name=root`,
  ].join('\n');
  // Hold the whole-disk lock so udev doesn't re-read the partition table
  // between sfdisk and mkfs (see systemd's BLOCK_DEVICE_LOCKING.md).
  return `d=$(readlink -f ${dev})
flock $d sh -euc '
printf "%s\\n" ${q(table).replaceAll("'", '"')} | sfdisk -q --wipe always $0
partx -u $0
mkfs.vfat -n EFI-SYSTEM \${0}2 >/dev/null
mkfs.ext4 -q -F -L boot \${0}3
mkfs.xfs -q -f -L root \${0}4' $d
udevadm settle
mkdir -p ${mnt} && mount \${d}4 ${mnt}
mkdir -p ${mnt}/boot && mount \${d}3 ${mnt}/boot
mkdir -p ${mnt}/boot/efi && mount \${d}2 ${mnt}/boot/efi`;
}

// Rewrite the deployment's /etc/fstab entries for /boot, /boot/efi and /efi
// to match the layout, keeping everything else.
function fstabScript(dev, layout) {
  const mnt = mountDir(dev);
  const lines = layout.fstab.map((e) => e === 'boot'
    ? 'UUID=$(blkid -s UUID -o value $bootpart) /boot ext4 defaults 1 2'
    : `UUID=$(blkid -s UUID -o value $esppart) ${e.slice('esp:'.length)} vfat umask=0077,shortname=winnt 0 2`);
  return `set -euo pipefail
part_of() { lsblk -nrp -o PATH,PARTTYPE ${dev} | awk -v t="$1" 'tolower($2)==tolower(t) {print $1}'; }
rootpart=$(part_of ${GPT.rootX86_64}); esppart=$(part_of ${GPT.esp})
bootpart=$(part_of ${GPT.linux})$(part_of ${GPT.xbootldr})
mkdir -p ${mnt}-f && mount $rootpart ${mnt}-f
d=$(ls -d ${mnt}-f/ostree/deploy/*/deploy/*.0 | head -1)
echo "== fstab as installed"; cat $d/etc/fstab 2>/dev/null || echo "(none)"
touch $d/etc/fstab
{ grep -vE '[[:space:]](/boot|/boot/efi|/efi)[[:space:]]' $d/etc/fstab || true
${lines.map((l) => `  echo "${l}"`).join('\n')}
} > ${mnt}.fstab
cat ${mnt}.fstab > $d/etc/fstab
chcon system_u:object_r:etc_t:s0 $d/etc/fstab
mkdir -p ${mnt}-f/boot/efi
echo "== fstab as tested"; cat $d/etc/fstab
umount ${mnt}-f`;
}

function bootcDiskName(image, variant, layoutName) {
  return `${image}--${variant}--${layoutName}`;
}

async function installBootcDisk(vm, dev, image, variant, layoutName) {
  const layout = BOOTC_LAYOUTS[layoutName];
  const tag = await ensureImages(vm, image, variant, !!layout.efiDir);
  const name = bootcDiskName(image, variant, layoutName);
  const mnt = mountDir(dev);
  let install;
  if (layout.boot === 'root') {
    install = `${PODMAN_INSTALL} ${q(tag)} bootc install to-disk --wipe --filesystem xfs ${INSTALL_ARGS} ${dev}`;
  } else {
    install = `${partitionScript(dev, layout.boot === 'xbootldr' ? GPT.xbootldr : GPT.linux)}
${PODMAN_INSTALL} -v ${mnt}:/target ${q(tag)} bootc install to-filesystem ${INSTALL_ARGS} /target
umount -R ${mnt}`;
  }
  log('builder', `installing ${name}`);
  const r1 = await vm.ssh(`set -euo pipefail\nwipefs -qa ${dev}\n${install}`, { timeoutS: 3600 });
  const r2 = await vm.ssh(fstabScript(dev, layout));
  const r3 = await vm.ssh(`lsblk -o NAME,SIZE,FSTYPE,PARTTYPE,PARTLABEL ${dev}; podman run --rm ${q(tag)} rpm -q systemd ostree bootc`);
  fs.writeFileSync(path.join(DISKS_DIR, `${name}.json`), JSON.stringify({
    name, kind: 'bootc', image, imageRef: BOOTC_IMAGES[image], variant, layoutName, layout,
    installedFrom: tag, nextArchive: nextArchive(image, variant, !!layout.efiDir), builtAt: ts(),
  }, null, 2));
  fs.writeFileSync(path.join(DISKS_DIR, `${name}.build.log`),
    `$ ${install}\n${r1.out}${r1.err}\n${r2.out}${r2.err}\n${r3.out}`);
}

async function cmdBuildBootc(opts) {
  const images = opts.image?.length ? opts.image : DEFAULT_BOOTC_IMAGES;
  const variants = opts.variant?.length ? opts.variant : VARIANTS;
  const layouts = opts.layout?.length ? opts.layout : Object.keys(BOOTC_LAYOUTS);
  fs.mkdirSync(DISKS_DIR, { recursive: true });
  const todo = [];
  for (const image of images) {
    for (const variant of variants) {
      for (const layout of layouts) {
        if (!BOOTC_LAYOUTS[layout]) throw new Error(`unknown layout ${layout}`);
        const name = bootcDiskName(image, variant, layout);
        if (!opts.force && fs.existsSync(path.join(DISKS_DIR, `${name}.json`))) continue;
        todo.push({ image, variant, layout, name, file: path.join(DISKS_DIR, `${name}.qcow2`) });
      }
    }
  }
  if (!todo.length) return log('build', 'all requested disks exist');
  const failures = [];
  // The q35 root bus has room for about 25 virtio disks; attach in batches.
  for (let start = 0; start < todo.length; start += BUILDER_MAX_TARGETS) {
    await buildBootcBatch(todo.slice(start, start + BUILDER_MAX_TARGETS), opts, failures);
  }
  if (failures.length) throw new Error(`failed to build: ${failures.join(', ')}`);
}

const BUILDER_MAX_TARGETS = 16;

async function buildBootcBatch(todo, opts, failures) {
  for (const t of todo) await qemuImg('create', '-q', '-f', 'qcow2', t.file, '20G');
  await withBuilder(todo.map((t) => t.file), async (vm) => {
    // Images are built serially (shared podman storage); installs to
    // different disks run in parallel.
    for (const t of todo) await ensureImages(vm, t.image, t.variant, !!BOOTC_LAYOUTS[t.layout].efiDir);
    await pool(todo.map((t, i) => async () => {
      try {
        await installBootcDisk(vm, `/dev/disk/by-id/virtio-t${i}`, t.image, t.variant, t.layout);
      } catch (e) {
        failures.push(t.name);
        log('builder', `FAILED ${t.name}: ${e.message}`);
        fs.writeFileSync(path.join(DISKS_DIR, `${t.name}.build-failed.log`), e.message);
      }
    }), opts.jobs ?? 4);
  });
}

// --- Silverblue ----------------------------------------------------------------

function kickstart(layout, pubkey) {
  const ca = extraCa();
  const drop = layout.drop.map((m) => `-e '\\#[[:space:]]${m.replaceAll('/', '\\/')}[[:space:]]#d'`).join(' ');
  return `text
lang en_US.UTF-8
keyboard us
timezone UTC --utc
network --bootproto=dhcp --activate
rootpw --lock
sshkey --username=root ${q(pubkey).replaceAll("'", '"')}
services --enabled=sshd
${SILVERBLUE_PAYLOAD}
zerombr
clearpart --all --initlabel --disklabel=gpt
${layout.parts}
bootloader --append="console=ttyS0,115200"
poweroff

%post --nochroot --erroronfail
set -x
for f in /mnt/sysroot/ostree/deploy/*/deploy/*.0/etc/fstab; do
  cp "$f" /tmp/fstab.anaconda
  # "services --enabled=sshd" does not take effect with this payload.
  ln -sf /usr/lib/systemd/system/sshd.service "$(dirname "$f")/systemd/system/multi-user.target.wants/sshd.service"
  ${drop ? `sed ${drop} /tmp/fstab.anaconda > /tmp/fstab.new && cat /tmp/fstab.new > "$f"` : 'true'}
  ${ca ? `printf '%s' ${q(ca)} > "$(dirname "$f")/pki/ca-trust/source/anchors/b2402-extra.pem"` : 'true'}
done
%end
`;
}

async function cmdInstallSilverblue(opts) {
  await cmdFetch();
  const pubkey = await ensureSshKey();
  const names = opts.layout?.length ? opts.layout : Object.keys(SILVERBLUE_LAYOUTS);
  const iso = path.join(STATE, 'dl', 'silverblue.iso');
  const boot = path.join(STATE, 'silverblue-pxe');
  fs.mkdirSync(boot, { recursive: true });
  fs.mkdirSync(DISKS_DIR, { recursive: true });
  for (const f of ['vmlinuz', 'initrd.img']) {
    if (!fs.existsSync(path.join(boot, f))) {
      await sh('xorriso', ['-osirrox', 'on', '-indev', iso, '-extract', `/images/pxeboot/${f}`, path.join(boot, f)]);
    }
  }
  const label = (await sh('xorriso', ['-indev', iso, '-pvd_info'])).out.match(/Volume Id\s*:\s*(\S+)/)[1];
  await pool(names.map((name) => async () => {
    const layout = SILVERBLUE_LAYOUTS[name];
    if (!layout) throw new Error(`unknown Silverblue layout ${name}`);
    if (!opts.force && fs.existsSync(path.join(DISKS_DIR, `${name}.json`))) return;
    const dir = path.join(DISKS_DIR, `${name}.install`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'oemdrv'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'oemdrv', 'ks.cfg'), kickstart(layout, pubkey));
    const oemdrv = path.join(dir, 'oemdrv.iso');
    await sh('mkisofs', ['-quiet', '-o', oemdrv, '-V', 'OEMDRV', '-J', '-r', path.join(dir, 'oemdrv')]);
    const disk = path.join(DISKS_DIR, `${name}.qcow2`);
    await qemuImg('create', '-q', '-f', 'qcow2', disk, '40G');
    const vm = new Vm(`install-${name}`, dir, {
      cpus: 4, memMiB: 8192, disks: [{ file: disk }], cdroms: [iso, oemdrv], noReboot: true,
      kernel: path.join(boot, 'vmlinuz'), initrd: path.join(boot, 'initrd.img'),
      append: `inst.stage2=hd:LABEL=${label} inst.ks=hd:LABEL=OEMDRV:/ks.cfg inst.text console=ttyS0,115200`,
    });
    log(name, 'installing from ISO');
    await vm.start();
    // Anaconda stops at "Press ENTER to exit" on errors; don't wait for it.
    const deadline = Date.now() + 5400 * 1000;
    while (!vm.dead) {
      const log = path.join(dir, 'serial.log');
      const serial = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      if (Date.now() > deadline || /Press ENTER to exit/.test(serial)) {
        vm.proc.kill('SIGKILL');
        throw new Error(`${name}: install failed or timed out; see ${dir}/serial.log`);
      }
      await sleep(10);
    }
    // Anaconda ends with poweroff; check it actually installed something.
    const serial = fs.readFileSync(path.join(dir, 'serial.log'), 'utf8');
    if (!/reboot: Power down|Powering off/.test(serial) || /Traceback|kickstart error/i.test(serial)) {
      throw new Error(`${name}: install did not finish cleanly; see ${dir}/serial.log`);
    }
    fs.copyFileSync(vm.varsFile, path.join(DISKS_DIR, `${name}.OVMF_VARS.fd`));
    fs.writeFileSync(path.join(DISKS_DIR, `${name}.json`), JSON.stringify({
      name, kind: 'silverblue', image: `silverblue-${FEDORA}`, imageRef: path.basename(DOWNLOADS['silverblue.iso']),
      variant: 'stock', layoutName: name, layout, builtAt: ts(),
    }, null, 2));
    log(name, 'installed');
  }), opts.jobs ?? 6);
}

// --- test runs ---------------------------------------------------------------

// Read-only probes: none of these access /boot, so they don't trigger (or
// reset the idle timer of) an automount.
const UNITS = ['boot.mount', 'boot.automount', 'efi.mount', 'efi.automount', 'boot-efi.mount', 'boot-efi.automount'];
const PROBE = `
echo "## versions"; uname -r; . /etc/os-release; echo "$PRETTY_NAME"; rpm -q systemd ostree bootc rpm-ostree 2>&1 | grep -v 'not installed'
echo "## firmware"; test -d /sys/firmware/efi && echo uefi || echo bios
# gpt-auto only mounts the ESP/XBOOTLDR on UEFI if the boot loader set this
# (UTF-16 after a 4-byte attribute header); BIOS boots skip the check.
echo "## LoaderDevicePartUUID"; tail -c +5 /sys/firmware/efi/efivars/LoaderDevicePartUUID-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f 2>/dev/null | tr -d '\\0' | grep . || echo "(unset)"
echo "## cmdline"; cat /proc/cmdline
echo "## lsblk"; lsblk -o NAME,SIZE,FSTYPE,PARTTYPENAME,MOUNTPOINTS
echo "## /etc/fstab"; grep -v '^#' /etc/fstab 2>/dev/null | grep . || echo "(empty or absent)"
echo "## /efi"; stat -c '%n: %F' /efi 2>&1
echo "## findmnt"; findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS /boot; findmnt -o TARGET,SOURCE,FSTYPE /efi; findmnt -o TARGET,SOURCE,FSTYPE /boot/efi; true
echo "## generator units for /boot and /efi"
for d in /run/systemd/generator.early /run/systemd/generator /run/systemd/generator.late; do
  for f in $(ls $d 2>/dev/null | grep -E '^(boot|efi|boot-efi)\\.(auto)?mount$'); do echo "--- $d/$f"; grep -vE '^(#|$)' $d/$f; done
done
echo "## systemctl status"; systemctl status --no-pager --lines=0 ${UNITS.join(' ')} 2>&1 | grep -vE '^\\s*$'
echo "## unit properties"
for u in ${UNITS.join(' ')}; do systemctl show -p Id,LoadState,ActiveState,FragmentPath,SourcePath,What,Where,Options,TimeoutIdleUSec $u | paste -sd' '; done
`;

const PROBE_STATE = `for u in boot.automount boot.mount; do printf '%s ' $(systemctl show -P LoadState $u) $(systemctl show -P ActiveState $u); done`;

const BOOTED_CHECKSUM = `ostree admin status 2>/dev/null | awk '/^\\* /{print $3; exit}'`;

function stepsFor(disk) {
  if (disk.kind === 'bootc') {
    return [{
      name: 'bootc-switch',
      prepare: { local: disk.nextArchive, remote: '/var/tmp/b2402-next.ociarchive' },
      stage: 'bootc switch --quiet --transport oci-archive /var/tmp/b2402-next.ociarchive',
      verify: `test -e ${NEXT_MARKER}`,
    }];
  }
  const steps = [];
  // The patched ostree has to be booted before the measured steps.
  if (disk.variant !== 'stock') {
    steps.push({
      name: `override-ostree-pr${OSTREE_PR}`, setup: true,
      setupScript: 'update-ca-trust',
      prepare: { localDir: disk.rpms, remote: '/var/tmp/b2402-rpms' },
      // Replace only the subpackages that are installed.
      stage: `rpm-ostree override replace $(for f in /var/tmp/b2402-rpms/*.rpm; do rpm -q "$(rpm -qp --qf '%{NAME}' "$f")" >/dev/null && echo "$f"; done)`,
      verify: 'rpm -q ostree | grep -q b2402',
    });
  }
  steps.push({
    name: 'rpm-ostree-upgrade',
    setupScript: 'update-ca-trust',
    stage: 'rpm-ostree upgrade',
    verify: `test "$(${BOOTED_CHECKSUM})" != "$B2402_BEFORE"`,
  }, {
    name: 'rpm-ostree-kargs',
    stage: 'rpm-ostree kargs --append=b2402.step=kargs',
    verify: 'grep -qw b2402.step=kargs /proc/cmdline',
  });
  return steps;
}

class Evidence {
  constructor(file) {
    this.file = file;
    fs.writeFileSync(file, '');
  }

  note(s) {
    fs.appendFileSync(this.file, `${s}\n`);
  }

  async cmd(vm, title, script, opts = {}) {
    const r = await vm.ssh(script, { check: false, ...opts });
    this.note(`### ${title} (${ts()})\n$ ${script.trim().split('\n').length > 3 ? '<probe script>' : script.trim()}\n${r.out}${r.err}[exit ${r.code}]\n`);
    return r;
  }
}

// Wait until /boot's automount has expired, i.e. boot.mount went inactive
// under an active boot.automount. Returns seconds waited, or null.
async function waitIdleOut(vm, maxS) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxS) {
    const s = (await vm.ssh(PROBE_STATE, { check: false })).out.trim().split(/\s+/);
    if (s[0] !== 'loaded' || s[1] !== 'active') return null;
    if (s[3] === 'inactive') return Math.round((Date.now() - start) / 1000);
    await sleep(5);
  }
  return null;
}

function parseProbe(out) {
  const props = {};
  // systemctl show prints properties in an order that differs between
  // systemd versions, so find Id= anywhere on the line.
  for (const line of out.split('\n')) {
    if (!/(^| )Id=\S/.test(line)) continue;
    const p = Object.fromEntries(line.split(' ').map((kv) => kv.split('=')).map(([k, ...v]) => [k, v.join('=')]));
    props[p.Id] = p;
  }
  const findmntBoot = out.split('## findmnt\n')[1]?.split('\n').filter((l) => l.startsWith('/boot ')) ?? [];
  return {
    firmware: out.match(/## firmware\n(\w+)/)?.[1],
    loaderPartUuid: out.match(/## LoaderDevicePartUUID\n(\S+)/)?.[1],
    versions: out.split('## versions\n')[1]?.split('\n## ')[0].trim(),
    fstab: out.split('## /etc/fstab\n')[1]?.split('\n## ')[0].trim(),
    findmntBoot,
    units: props,
  };
}

async function runOne(diskName, { firmware, idle = true, tag, variant }) {
  const disk = JSON.parse(fs.readFileSync(path.join(DISKS_DIR, `${diskName}.json`), 'utf8'));
  if (variant && variant !== disk.variant) {
    if (disk.kind !== 'silverblue') throw new Error('only Silverblue disks take a run-time variant');
    disk.variant = variant;
    disk.rpms = path.join(STATE, 'rpms', 'fedora-bootc-45');
  }
  const variantTag = variant && variant !== 'stock' ? `--${variant}` : '';
  const id = `${diskName}${variantTag}--${firmware}${idle ? '' : '--noidle'}${tag ? `--${tag}` : ''}`;
  const dir = path.join(RUNS_DIR, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const overlay = path.join(dir, 'disk.qcow2');
  await qemuImg('create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', path.join(DISKS_DIR, `${diskName}.qcow2`), overlay);
  const vars = path.join(DISKS_DIR, `${diskName}.OVMF_VARS.fd`);
  const vm = new Vm(id, dir, {
    firmware, disks: [{ file: overlay }], memMiB: disk.kind === 'silverblue' ? 4096 : 3072,
    varsFrom: fs.existsSync(vars) ? vars : undefined,
  });
  const ev = new Evidence(path.join(dir, 'evidence.txt'));
  const result = { id, disk: diskName, kind: disk.kind, image: disk.image, variant: disk.variant, layout: disk.layoutName, firmware, idle, startedAt: ts(), steps: [] };
  ev.note(`# ${id}\n${JSON.stringify(disk, null, 2)}\n`);
  await vm.start();
  try {
    await vm.waitSsh(900);
    const p0 = await ev.cmd(vm, 'initial state', PROBE);
    Object.assign(result, { initial: parseProbe(p0.out) });
    const u = result.initial.units;
    result.bootAutomount = u['boot.automount']?.LoadState === 'loaded';
    result.idleTimeout = u['boot.automount']?.TimeoutIdleUSec ?? null;
    result.bootMountUnit = u['boot.mount']?.FragmentPath || null;
    result.bootMountWhat = u['boot.mount']?.What || null;
    for (const step of stepsFor(disk)) {
      const sr = { name: step.name, setup: !!step.setup };
      result.steps.push(sr);
      if (step.prepare?.local) await vm.scpTo(step.prepare.local, step.prepare.remote);
      if (step.prepare?.localDir) {
        await vm.ssh(`mkdir -p ${step.prepare.remote}`);
        for (const f of fs.readdirSync(step.prepare.localDir).filter((f) => f.endsWith('.rpm'))) {
          await vm.scpTo(path.join(step.prepare.localDir, f), `${step.prepare.remote}/${f}`);
        }
      }
      if (step.setupScript) await ev.cmd(vm, `${step.name}: setup`, step.setupScript);
      const before = (await vm.ssh(BOOTED_CHECKSUM)).out.trim();
      if (idle && !step.setup) {
        sr.idleOutBeforeStage = await waitIdleOut(vm, IDLE_WAIT_S);
        await ev.cmd(vm, `${step.name}: after waiting for idle-out (${sr.idleOutBeforeStage ?? 'no'}s)`, `${PROBE_STATE}; echo; findmnt /boot`);
      } else {
        await vm.ssh('ls /boot >/dev/null');
      }
      const t0 = Date.now();
      let st = await ev.cmd(vm, `${step.name}: stage`, step.stage, { timeoutS: 3600 });
      sr.stageExit = st.code;
      sr.stageSeconds = Math.round((Date.now() - t0) / 1000);
      if (st.code !== 0) {
        sr.stageError = (st.err || st.out).trim().split('\n').slice(-3).join(' | ');
        // Touching /boot from the shell remounts it; retry so the finalize
        // path still gets exercised.
        st = await ev.cmd(vm, `${step.name}: stage again after ls /boot`, `ls /boot >/dev/null; ${step.stage}`, { timeoutS: 3600 });
        sr.stageRetryExit = st.code;
        if (st.code !== 0) break;
      }
      await ev.cmd(vm, `${step.name}: staged`, 'ostree admin status; systemctl status --no-pager --lines=3 ostree-finalize-staged.service ostree-finalize-staged-hold.service');
      if (idle && !step.setup) {
        sr.idleOutAfterStage = await waitIdleOut(vm, IDLE_WAIT_S);
        await ev.cmd(vm, `${step.name}: after waiting for idle-out (${sr.idleOutAfterStage ?? 'no'}s)`, `${PROBE_STATE}; echo; findmnt /boot`);
      }
      await vm.reboot();
      const fin = await ev.cmd(vm, `${step.name}: previous boot's finalize`,
        'journalctl -b -1 -o short-monotonic --no-pager -u ostree-finalize-staged.service -u ostree-finalize-staged-hold.service | tail -n 40');
      sr.finalizeLog = fin.out.split('\n').filter((l) => /error|fail|Finished|Deactivated|Bootloader updated/i.test(l)).map((l) => l.replace(/^\[\s*[\d.]+\]\s*\S+\s*/, '')).slice(0, 6);
      const v = await ev.cmd(vm, `${step.name}: verify`, `B2402_BEFORE=${q(before)}; ${step.verify}`);
      sr.bootedNew = v.code === 0;
      await ev.cmd(vm, `${step.name}: state after reboot`, PROBE);
      if (!sr.bootedNew) break;
    }
    const measured = result.steps.filter((s) => !s.setup);
    result.updateSurvived = measured.length > 0 && measured.every((s) => s.bootedNew);
  } catch (e) {
    result.error = e.message;
    ev.note(`### harness error\n${e.stack}`);
  } finally {
    await vm.stop().catch(() => {});
    fs.rmSync(overlay, { force: true });
  }
  result.finishedAt = ts();
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  log(id, `done: survived=${result.updateSurvived} automount=${result.bootAutomount}${result.error ? ` error=${result.error}` : ''}`);
  return result;
}

async function pool(tasks, n) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
}

function allDisks() {
  if (!fs.existsSync(DISKS_DIR)) return [];
  return fs.readdirSync(DISKS_DIR).filter((f) => f.endsWith('.json') && !f.includes('.build'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DISKS_DIR, f), 'utf8')));
}

async function cmdMatrix(opts) {
  const re = opts.filter ? new RegExp(opts.filter) : null;
  const tasks = [];
  for (const d of allDisks()) {
    const firmwares = opts.firmware?.length ? opts.firmware : (d.layout.firmware ?? ['uefi']);
    for (const fw of firmwares) {
      const id = `${d.name}--${fw}${opts['no-idle'] ? '--noidle' : ''}`;
      if (re && !re.test(id)) continue;
      if (!opts.force && fs.existsSync(path.join(RUNS_DIR, id, 'result.json'))) continue;
      tasks.push(() => runOne(d.name, { firmware: fw, idle: !opts['no-idle'] }));
    }
  }
  log('matrix', `${tasks.length} runs, ${opts.jobs ?? 12} at a time`);
  await pool(tasks, opts.jobs ?? 12);
}

// Silverblue disks are installed once, stock; the PR series is applied at run
// time with rpm-ostree override replace.
async function cmdRunSilverbluePatched(opts) {
  const re = opts.filter ? new RegExp(opts.filter) : null;
  const tasks = allDisks().filter((d) => d.kind === 'silverblue' && (!re || re.test(d.name)))
    .map((d) => () => runOne(d.name, { firmware: 'uefi', idle: !opts['no-idle'], variant: `pr${OSTREE_PR}` }));
  await pool(tasks, opts.jobs ?? 6);
}

async function cmdFetchRpms() {
  // Copy the PR build for Fedora out of the builder for the Silverblue runs.
  await withBuilder([], async (vm) => {
    await buildPatchedOstree(vm, 'fedora-bootc-45');
    const dir = path.join(STATE, 'rpms', 'fedora-bootc-45');
    fs.mkdirSync(dir, { recursive: true });
    const files = (await vm.ssh('ls /var/b2402/rpms/fedora-bootc-45/*.rpm')).out.trim().split('\n');
    for (const f of files) await vm.scpFrom(f, path.join(dir, path.basename(f)));
    await vm.scpFrom(`/var/b2402/patches-pr${OSTREE_PR}/HEAD`, path.join(STATE, 'rpms', `pr${OSTREE_PR}-HEAD`));
  });
}

function yn(v) {
  return v === true ? 'yes' : v === false ? 'no' : '-';
}

function cmdReport() {
  const rows = [];
  for (const id of fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).sort() : []) {
    const f = path.join(RUNS_DIR, id, 'result.json');
    if (!fs.existsSync(f)) continue;
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    const measured = r.steps.filter((s) => !s.setup);
    const stage = measured.map((s) => s.stageExit === 0 ? 'ok' : `FAIL(${s.stageRetryExit === 0 ? 'ok after ls' : 'failed again'})`).join(', ');
    const idleOut = measured.map((s) => `${s.idleOutBeforeStage ?? 'no'}/${s.idleOutAfterStage ?? 'no'}`).join(', ');
    const fstabMounts = r.initial?.fstab?.split('\n').filter((l) => /\s(\/boot|\/boot\/efi|\/efi)\s/.test(l)).map((l) => l.split(/\s+/)[1]) ?? [];
    const units = r.initial?.units ?? {};
    const otherAuto = Object.entries(units).filter(([k, v]) => k !== 'boot.automount' && k.endsWith('.automount') && v.LoadState === 'loaded').map(([k]) => k).join(' ');
    const finalize = measured.map((s) => s.finalizeLog?.find((l) => /error:/.test(l))?.replace(/^.*error: /, '') ?? 'ok').join(', ');
    const flags = r.idle ? '' : ' (no idle wait)';
    const noLoaderUuid = r.firmware === 'uefi' && r.initial?.loaderPartUuid === '(unset)' ? ' (no LoaderDevicePartUUID)' : '';
    rows.push(`| ${r.image} | ${r.variant} | ${r.layout}${flags} | ${r.firmware}${noLoaderUuid} | ${fstabMounts.join(' ') || 'none'} | ${yn(r.bootAutomount)}${otherAuto ? ` (+${otherAuto})` : ''} | ${r.bootAutomount ? r.idleTimeout : '-'} | ${bootMountedBy(units['boot.mount'], fstabMounts)} | ${idleOut} | ${stage || '-'} | ${finalize || '-'} | ${r.error ? `ERROR: ${r.error.split('\n')[0]}` : yn(r.updateSurvived)} |`);
  }
  console.log('| image | ostree | layout | firmware | fstab entries | boot.automount | idle timeout | /boot mounted by | idle-out before/after stage (s) | stage | finalize | update survived |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(r);
}

// Which generator's boot.mount won: gpt-auto writes to generator.late,
// fstab-generator and ostree to the normal generator directory.
function bootMountedBy(u, fstabMounts) {
  if (!u || u.LoadState !== 'loaded') return 'nothing';
  if (u.FragmentPath.includes('generator.late')) return `gpt-auto (${u.What})`;
  const fromFstab = u.SourcePath !== undefined ? u.SourcePath === '/etc/fstab' : fstabMounts.includes('/boot');
  if (fromFstab) return `fstab (${u.What})`;
  if (u.FragmentPath.startsWith('/run/systemd/generator')) return `ostree bind (${u.What})`;
  return u.FragmentPath;
}

const USAGE = `usage: node harness.mjs <command> [options]

  fetch                     download the Fedora Cloud image (builder) and the Silverblue ISO
  build-bootc               install bootc disks: [--image NAME]... [--variant stock|pr${OSTREE_PR}]... [--layout NAME]... [--force] [--jobs N]
  fetch-rpms                build ostree with PR ${OSTREE_PR} for Fedora and copy the RPMs out (for Silverblue)
  install-silverblue        install Silverblue from the ISO: [--layout NAME]... [--force] [--jobs N]
  run DISK                  one test run: [--firmware uefi|bios] [--no-idle] [--tag T] [--variant pr${OSTREE_PR} (Silverblue)]
  matrix                    run every built disk: [--filter REGEX] [--firmware F]... [--no-idle] [--force] [--jobs N]
  silverblue-pr             run the Silverblue disks with ostree PR ${OSTREE_PR} applied via override replace
  report                    print the results table (Markdown)

State lives in $B2402_STATE (default /var/tmp/b2402).
bootc images: ${Object.keys(BOOTC_IMAGES).join(', ')} (default ${DEFAULT_BOOTC_IMAGES.join(', ')})
bootc layouts: ${Object.keys(BOOTC_LAYOUTS).join(', ')}
Silverblue layouts: ${Object.keys(SILVERBLUE_LAYOUTS).join(', ')}`;

async function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      image: { type: 'string', multiple: true },
      variant: { type: 'string', multiple: true },
      layout: { type: 'string', multiple: true },
      firmware: { type: 'string', multiple: true },
      filter: { type: 'string' },
      tag: { type: 'string' },
      jobs: { type: 'string' },
      force: { type: 'boolean' },
      'no-idle': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (opts.jobs) opts.jobs = Number(opts.jobs);
  const [cmd, ...rest] = positionals;
  await ensureSshKey();
  switch (cmd) {
    case 'fetch': return cmdFetch();
    case 'build-bootc': return cmdBuildBootc(opts);
    case 'fetch-rpms': return cmdFetchRpms();
    case 'install-silverblue': return cmdInstallSilverblue(opts);
    case 'run': {
      if (!rest[0]) throw new Error('run needs a disk name');
      const r = await runOne(rest[0], { firmware: opts.firmware?.[0] ?? 'uefi', idle: !opts['no-idle'], tag: opts.tag, variant: opts.variant?.[0] });
      return console.log(JSON.stringify(r, null, 2));
    }
    case 'matrix': return cmdMatrix(opts);
    case 'silverblue-pr': return cmdRunSilverbluePatched(opts);
    case 'report': return cmdReport();
    default:
      console.log(USAGE);
      process.exitCode = cmd || opts.help ? 0 : 2;
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
