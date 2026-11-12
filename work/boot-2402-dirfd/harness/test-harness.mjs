import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const harness = fileURLToPath(new URL('.', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'boot-harness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const mock = (name, code) => writeFileSync(join(dir, name),
    `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
  const run = (script, args = []) => spawnSync('/bin/bash',
    [join(harness, script), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 5000 });
  return { dir, env, mock, run };
}

test('matrix preserves empty modes and runs all twenty cases', t => {
  const { dir, env, mock, run } = fixture(t);
  env.CALL_LOG = join(dir, 'calls');
  mock('bash', `require('node:fs').appendFileSync(process.env.CALL_LOG,
    JSON.stringify(process.argv.slice(2)) + '\\n');`);
  for (const name of ['qemu-img', 'qemu-system-x86_64', 'ssh']) mock(name, '');
  const result = run('run-matrix.sh', ['stock', 'main', 'pr3690', 'dirfd']);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(env.CALL_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 20);
  for (const variant of ['stock', 'main', 'pr3690', 'dirfd']) {
    const rows = calls.filter(row => row[1].includes(`-${variant}-`));
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map(row => row[4]).sort(), ['', '', '', 'automount', 'umount']);
    assert.ok(rows.every(row => row.length === 5));
  }
  assert.equal(new Set(calls.map(row => row[3])).size, 20);
});

test('matrix propagates a failed scenario', t => {
  const { mock, run } = fixture(t);
  for (const name of ['qemu-img', 'qemu-system-x86_64', 'ssh']) mock(name, '');
  mock('bash', 'process.exit(1);');
  assert.equal(run('run-matrix.sh', ['stock']).status, 123);
});

test('scenario exits immediately when VM startup fails', t => {
  const { dir, mock, run } = fixture(t);
  writeFileSync(join(dir, 'disk.raw'), '');
  mock('qemu-img', 'process.exit(7);');
  const result = run('run-scenario.sh', ['disk.raw', 'result', '2401']);
  assert.equal(result.status, 7, result.stderr);
});

test('staging and unmount failures are not hidden by diagnostic output', t => {
  const { mock, run } = fixture(t);
  mock('bootc', 'process.exit(9);');
  mock('umount', 'process.exit(8);');
  assert.equal(run('guest.sh', ['stage']).status, 9);
  assert.equal(run('guest.sh', ['umount']).status, 8);
});

test('native Silverblue staging does not require bootc status', t => {
  const { mock, run } = fixture(t);
  mock('bootc', 'process.exit(9);');
  mock('ostree', `if (process.argv.includes('status')) console.log('* default ' + 'a'.repeat(64) + '.0');`);
  assert.equal(run('guest.sh', ['stage', 'silverblue']).status, 0);
  mock('ostree', 'process.exit(8);');
  assert.equal(run('guest.sh', ['stage', 'silverblue']).status, 8);
});

test('automount setup failure aborts the scenario', t => {
  const { dir, mock, run } = fixture(t);
  writeFileSync(join(dir, 'disk.raw'), '');
  for (const name of ['qemu-img', 'qemu-system-x86_64']) mock(name, '');
  mock('ssh', `if (process.argv.includes('automount')) process.exit(9);
    if (process.argv.includes('bootid')) console.log('mock-boot-id');`);
  assert.equal(run('run-scenario.sh', ['disk.raw', 'result', '2401', 'automount']).status, 9);
});

test('lost deployment makes the guest check fail', t => {
  const { mock, run } = fixture(t);
  mock('grep', 'process.exit(process.argv.includes("-qw") ? 1 : 0);');
  for (const name of ['ls', 'journalctl']) mock(name, '');
  const result = run('guest.sh', ['check']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /RESULT: staged deployment LOST/);
});

test('missing interactive karg also fails when the staged marker passed', t => {
  const { mock, run } = fixture(t);
  mock('grep', 'process.exit(process.argv.includes("-FH") ? 1 : 0);');
  for (const name of ['ls', 'journalctl']) mock(name, '');
  const result = run('guest.sh', ['check']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /RESULT: staged deployment booted/);
});

test('automount setup handles bootc auto,ro options without touching other entries', t => {
  const { dir, env, mock, run } = fixture(t);
  env.FSTAB_FIXTURE = join(dir, 'fstab');
  const input = '# /dev/comment /boot ext4 defaults 0 2\n'
    + 'UUID=boot /boot ext4 auto,ro 0 2\nUUID=root / xfs defaults 0 0\n';
  writeFileSync(env.FSTAB_FIXTURE, input);
  mock('sed', `const args = process.argv.slice(2); args[args.length - 1] = process.env.FSTAB_FIXTURE;
    process.exit(require('node:child_process').spawnSync('/usr/bin/sed', args).status);`);
  const result = run('guest.sh', ['automount']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(env.FSTAB_FIXTURE, 'utf8'), input.replace(
    'auto,ro', 'auto,ro,x-systemd.automount,x-systemd.idle-timeout=60'));
});
