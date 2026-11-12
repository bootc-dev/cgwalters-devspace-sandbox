// Continue the two remaining batches without changing the historical harness.
// The immutable helper revision also pins the 28854659 source build.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const REVISION = 'be7a48d763c67e018a6f2ccbae8ef4c2c15fd954';
const STATE = path.resolve(process.env.B2402_STATE ?? '/var/tmp/b2402-remaining');
process.env.B2402_STATE = STATE;
const images = ['fedora-bootc-44', 'fedora-bootc-45'];
const variants = ['stock', 'pr3690-28854659'];
const centosImages = ['centos-bootc-9', 'centos-bootc-10'];
const layouts = Object.fromEntries(['bios', 'uefi'].flatMap((firmware) =>
  ['xfs', 'btrfs'].map((filesystem) => [`default-${firmware}-${filesystem}`, {
    boot: 'default', firmware: [firmware], installFirmware: firmware, filesystem,
  }])));

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `historical source changed: ${before}`);
  return source.replace(before, after);
}

// Run only after both updates: accessing /boot cannot contaminate idle tests.
// Mount the actual ESP read-only in a private namespace, even without fstab.
const INVENTORY = `set -euo pipefail
esp=$(lsblk -nrpo PATH,PARTTYPE | awk 'tolower($2)=="c12a7328-f81f-11d2-ba4b-00a0c93ec93b" {print $1}'); test "$(printf '%s\\n' "$esp" | wc -l)" -eq 1; test -b "$esp"
mkdir -p /run/b2402-esp; mount -o ro,nosuid,nodev,noexec "$esp" /run/b2402-esp; trap 'umount /run/b2402-esp' EXIT
echo '=== mounts ==='; findmnt /boot; findmnt /run/b2402-esp; ostree admin status; bootc status --json
echo '=== recursive inventory ==='; find /boot /run/b2402-esp -printf '%y %p -> %l\\n' | sort
echo '=== loader configurations ==='; find /boot /run/b2402-esp -type f \\( -name '*.conf' -o -name '*.cfg' \\) -print -exec cat {} \\;
echo '=== resolved slots ==='; find -H /sysroot/ostree/boot.* -type l -print -exec readlink -e {} +
echo '=== retained deployments ==='; find /sysroot/ostree/deploy -mindepth 3 -maxdepth 3 -printf '%y %p -> %l\\n'
echo '=== kernel and initramfs hashes ==='; find /boot /run/b2402-esp -type f \\( -name '*vmlinuz*' -o -name '*initr*' \\) -exec sha256sum {} +`;

async function helpers() {
  let source = execFileSync('git', ['show', `${REVISION}:work/boot-2402/harness.mjs`], { encoding: 'utf8' });
  const entry = '\nmain().catch((e) => {';
  assert.equal(source.split(entry).length, 2);
  source = source.slice(0, source.indexOf(entry));
  source = replaceOnce(source, 'const BOOTC_LAYOUTS = {', `const BOOTC_LAYOUTS = {\n...${JSON.stringify(layouts)},`);
  source = replaceOnce(source,
    "${INSTALL_ARGS.replace('--generic-image ', '')} ${dev}`;",
    "${INSTALL_ARGS.replace('--generic-image ', '')} ${layout.filesystem ? '--filesystem ' + layout.filesystem : ''} ${dev}`;");
  // Default layouts must not be rewritten, or require a root-subvolume guess.
  source = replaceOnce(source, 'const r2 = await vm.ssh(fstabScript(dev, layout));',
    "const r2 = await vm.ssh(layout.boot === 'default' ? 'true' : fstabScript(dev, layout));");
  return import(`data:text/javascript;base64,${Buffer.from(source + '\nexport { cmdBuildBootc, runOne, pool, Evidence, ensureSshKey };').toString('base64')}`);
}

function failed(r, command) {
  return r.error || !r.updateSurvived ||
    r.steps.some((s) => s.stageExit !== 0 ||
      (command === 'idle' && r.bootAutomount && !Number.isFinite(s.idleOutBeforeStage))) ||
    (command === 'cleanup' && (r.cleanupExit !== 0 || r.gcExit !== 0));
}

function auditInventory(inventory) {
  assert.equal(inventory.code, 0);
  const section = (name) => {
    const parts = inventory.out.split(`=== ${name} ===\n`);
    assert.equal(parts.length, 2, `missing/duplicate section ${name}`);
    return parts[1].split('=== ')[0].trim();
  };
  const files = section('recursive inventory').split('\n').map((line) => {
    const match = line.match(/^([dfl]) (\S+) -> (.*)$/);
    assert.ok(match, `unrecognized inventory line: ${line}`);
    return { type: match[1], path: match[2], target: match[3] };
  });
  const regular = new Set(files.filter((f) => f.type === 'f').map((f) => f.path));
  for (const f of files.filter((f) => /(?:vmlinuz|initramfs|initrd)/.test(path.basename(f.path)) || /\/entries\/[^/]+$/.test(f.path))) {
    assert.equal(f.type, 'f', `unexpected non-regular payload/entry: ${f.path}; inspect manually`);
  }
  const entries = [];
  const configs = section('loader configurations').split(/^(\/(?:boot|run\/b2402-esp)\/.*\.(?:cfg|conf))$/m);
  for (let i = 1; i < configs.length; i += 2) {
    if (!configs[i].endsWith('.conf')) continue;
    const content = configs[i + 1];
    const slot = content.match(/\bostree=(\/ostree\/\S+)/)?.[1];
    assert.ok(slot, `no deployment slot in ${configs[i]}`);
    const payload = [...content.matchAll(/^(?:linux|initrd)\s+(.+)$/gm)].flatMap((m) => m[1].split(/\s+/));
    assert.ok(payload.length >= 2, `missing kernel/initramfs in ${configs[i]}`);
    const references = payload.map((p) => regular.has(p) ? p : `/boot${p}`);
    for (const p of references) assert.ok(regular.has(p), `missing payload ${p}`);
    entries.push({ path: configs[i], slot: `/sysroot${slot}`, references });
  }
  const slotLines = section('resolved slots').split('\n');
  const slots = slotLines.filter((p) => p.startsWith('/sysroot/ostree/boot.'));
  const targets = slotLines.filter((p) => p.startsWith('/sysroot/ostree/deploy/'));
  assert.ok(slots.length > 0);
  assert.equal(slots.length, targets.length, 'unresolved deployment slot');
  const resolved = new Map(slots.map((p, i) => [p, targets[i]]));
  const retained = section('retained deployments').split('\n').flatMap((line) =>
    line.match(/^d (\/sysroot\/ostree\/deploy\/[^/]+\/deploy\/[a-f0-9]{64}\.\d+) ->/)?.[1] ?? []);
  assert.equal(retained.length, 2, 'expected booted and rollback deployments');
  for (const target of targets) assert.ok(retained.includes(target), `unretained deployment ${target}`);
  assert.equal(entries.length, retained.length, 'extra/missing loader entries');
  assert.equal(files.filter((f) => f.type === 'f' && /\/loader[^/]*\/entries\//.test(f.path)).length, entries.length);
  for (const e of entries) assert.ok(resolved.has(e.slot), `unresolved loader reference ${e.slot}`);
  assert.equal(new Set(entries.map((e) => resolved.get(e.slot))).size, retained.length);
  const references = new Set(entries.flatMap((e) => e.references));
  const payloads = [...regular].filter((p) => /(?:vmlinuz|initramfs|initrd)/.test(path.basename(p)));
  for (const p of payloads) {
    const companion = path.join(path.dirname(p), path.basename(p).replace(/^\./, '').replace(/\.hmac$/, ''));
    assert.ok(references.has(p) || (p.endsWith('.hmac') && references.has(companion)), `orphan payload ${p}`);
  }
  return { entries, retained, payloads, espFiles: [...regular].filter((p) => p.startsWith('/run/b2402-esp/')),
    hashes: section('kernel and initramfs hashes').split('\n').sort() };
}

async function main() {
  const command = process.argv[2];
  const centos = ['build-centos', 'cleanup-centos', 'report-centos'].includes(command);
  const cases = centos ? ['bios', 'uefi'].map((firmware) => ['root', { installFirmware: firmware }]) : Object.entries(layouts);
  const selectedImages = centos ? centosImages : images;
  if (['report', 'report-cleanup', 'report-centos'].includes(command)) {
    for (const image of selectedImages) for (const variant of variants) for (const [layout, config] of cases) {
      const id = `${image}--${variant}--${layout}--${config.installFirmware}`;
      const read = (suffix, file) => JSON.parse(fs.readFileSync(path.join(STATE, 'runs', id + suffix, file), 'utf8'));
      const r = command === 'report' ? read('', 'result.json') : null;
      if (r) {
        assert.equal(r.error, undefined, `${id}: harness error`);
        assert.equal(r.steps.length, 1);
        assert.equal(r.steps[0].stageExit, 0);
        assert.equal(r.steps[0].stageRetryExit, undefined, `${id}: stage required intervention`);
        assert.equal(r.bootAutomount, true);
        assert.ok(Number.isFinite(r.steps[0].idleOutBeforeStage), `${id}: no witnessed idle-out`);
        assert.equal(r.updateSurvived, variant !== 'stock', `${id}: unexpected update outcome`);
        if (variant === 'stock') assert.match(r.steps[0].finalizeLog.join('\n'), /Remounting \/boot read-write: Invalid argument/);
      }
      const cleanup = read('--noidle--cleanup', 'result.json');
      assert.equal(Boolean(failed(cleanup, 'cleanup')), false, `${id}: cleanup failed`);
      assert.equal(cleanup.secondUpdateVerified, true);
      const before = auditInventory(read('--noidle--cleanup', 'before-recursive-inventory.json'));
      const after = auditInventory(read('--noidle--cleanup', 'after-recursive-inventory.json'));
      assert.deepEqual(before, after, `${id}: inventory changed during cleanup; inspect manually`);
      const summary = { id, stageExit: r?.steps[0]?.stageExit, idleBefore: r?.steps[0]?.idleOutBeforeStage,
        idleAfter: r?.steps[0]?.idleOutAfterStage, survived: r?.updateSurvived, error: r?.error,
        cleanup: [cleanup.cleanupExit, cleanup.gcExit], entries: after.entries.length,
        retained: after.retained.length, payloads: after.payloads.length, espFiles: after.espFiles.length };
      console.log(JSON.stringify(process.argv.includes('--verbose') ? { ...summary,
        finalize: r?.steps[0]?.finalizeLog,
        entries: after.entries.map((e) => e.path), retained: after.retained,
        payloads: after.payloads, espFiles: after.espFiles, hashes: after.hashes } : summary,
      null, process.argv.includes('--verbose') ? 2 : undefined));
    }
    return;
  }
  if (command === '--test') {
    assert.throws(() => replaceOnce('aaa', 'a', 'b'));
    assert.equal(replaceOnce('abc', 'b', 'd'), 'adc');
    assert.equal(Object.keys(layouts).length, 4);
    execFileSync('bash', ['-n'], { input: INVENTORY });
    const pass = { updateSurvived: true, bootAutomount: true, steps: [{ stageExit: 0, idleOutBeforeStage: 150 }] };
    assert.equal(Boolean(failed(pass, 'idle')), false);
    assert.equal(Boolean(failed({ ...pass, steps: [{ stageExit: 1, stageRetryExit: 0 }] }, 'idle')), true);
    assert.equal(Boolean(failed({ ...pass, steps: [{ stageExit: 0, idleOutBeforeStage: null }] }, 'idle')), true);
    assert.equal(Boolean(failed({ ...pass, cleanupExit: 0, gcExit: 2 }, 'cleanup')), true);
    assert.equal(Boolean(failed({ ...pass, cleanupExit: 0, gcExit: 0 }, 'cleanup')), false);
    assert.throws(() => auditInventory({ code: 0, out: '' }), /section/);
    const deployments = ['a', 'b'].map((c) => `/sysroot/ostree/deploy/default/deploy/${c.repeat(64)}.0`);
    const slots = ['/sysroot/ostree/boot.0/default/test/0', '/sysroot/ostree/boot.0/default/test/1'];
    const fixture = {
      'recursive inventory': ['f /boot/ostree/vmlinuz -> ', 'f /boot/ostree/initramfs -> ',
        'f /boot/loader.0/entries/0.conf -> ', 'f /boot/loader.0/entries/1.conf -> ', 'l /boot/loader -> loader.0'],
      'loader configurations': [0, 1].map((i) => `/boot/loader.0/entries/${i}.conf\noptions ostree=${slots[i].slice('/sysroot'.length)}\nlinux /ostree/vmlinuz\ninitrd /ostree/initramfs`),
      'resolved slots': [...slots, ...deployments],
      'retained deployments': deployments.map((p) => `d ${p} -> `),
      'kernel and initramfs hashes': ['kernel-hash /boot/ostree/vmlinuz', 'initramfs-hash /boot/ostree/initramfs'],
    };
    const out = Object.entries(fixture).map(([name, lines]) => `=== ${name} ===\n${lines.join('\n')}\n`).join('');
    assert.equal(auditInventory({ code: 0, out }).entries.length, 2);
    assert.throws(() => auditInventory({ code: 0, out: out.replace('l /boot/loader', 'f /boot/ostree/initrd-old -> \nl /boot/loader') }), /orphan/);
    assert.throws(() => auditInventory({ code: 0, out: out.replace('initrd /ostree/initramfs', 'initrd /missing') }), /missing payload/);
    assert.throws(() => auditInventory({ code: 0, out: out.replace(deployments[0] + '\n', '/missing\n') }), /unresolved/);
    await helpers();
    console.log('Helper transforms, four layouts, shell syntax, failure classification and inventory checks passed.');
    return;
  }
  if (!['build', 'build-centos', 'idle', 'cleanup', 'cleanup-centos'].includes(command)) throw new Error('usage: remaining-gaps.mjs build|idle|cleanup|report|report-cleanup|build-centos|cleanup-centos|report-centos|--test');
  const { cmdBuildBootc, runOne, pool, Evidence, ensureSshKey } = await helpers();
  await ensureSshKey();
  if (command === 'build' || command === 'build-centos') {
    return cmdBuildBootc({ image: selectedImages, variant: variants, layout: centos ? ['root'] : Object.keys(layouts), jobs: 4 });
  }
  const original = Evidence.prototype.cmd;
  Evidence.prototype.cmd = async function (vm, title, script, opts) {
    const result = await original.call(this, vm, title, script, opts);
    if (title === 'before cleanup inventory' || title === 'after cleanup inventory') {
      const inspection = await original.call(this, vm, `${title}: recursive boot and read-only ESP inspection`,
        `unshare -m --propagation private -- bash -c '${INVENTORY.replaceAll("'", "'\\''")}'`);
      fs.writeFileSync(path.join(path.dirname(this.file), `${title.startsWith('before') ? 'before' : 'after'}-recursive-inventory.json`), JSON.stringify(inspection, null, 2) + '\n');
      if (inspection.code !== 0) throw new Error('recursive boot/ESP inspection failed');
    }
    return result;
  };
  const tasks = [];
  const results = [];
  for (const image of selectedImages) for (const variant of variants) for (const [layout, config] of cases) {
    tasks.push(async () => {
      const r = await runOne(`${image}--${variant}--${layout}`, {
        firmware: config.installFirmware, idle: command === 'idle', cleanupOnly: command !== 'idle',
      });
      results.push(r);
    });
  }
  await pool(tasks, 8);
  // Stock reproductions intentionally fail; retain that nonzero exit instead
  // of letting a matrix with failing controls silently return success.
  if (results.length !== selectedImages.length * variants.length * cases.length ||
      results.some((r) => failed(r, command === 'idle' ? 'idle' : 'cleanup'))) process.exitCode = 1;
}

main().catch((e) => {
  // Imported helper stack traces contain the entire base64 source URL.
  console.error(e.message);
  process.exitCode = 1;
});
