// Focused continuation of PR 63, reusing its pinned PR 62 VM/build harness.
// Fetch the revision below first; see RESULTS.md for build/run commands.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const REVISION = 'be7a48d763c67e018a6f2ccbae8ef4c2c15fd954';
const WAIT_SECONDS = 600;
const STATE = path.resolve(process.env.B2402_STATE ?? '/var/tmp/b2402-post-stage');
const UNITS = 'boot.automount boot.mount ostree-finalize-staged.service ostree-finalize-staged-hold.service';
// Neither command resolves /boot or accesses a file beneath it.
const SNAPSHOT = `systemctl show ${UNITS} -p Id,LoadState,ActiveState,SubState,TimeoutIdleUSec,ExecStart,ExecStop,MainPID
echo '--- mounts ---'
cat /proc/mounts`;

function classify(out) {
  const [properties, mounts] = out.split('--- mounts ---\n');
  if (mounts === undefined) throw new Error('missing /proc/mounts snapshot');
  const units = Object.fromEntries(properties.trim().split(/\n\s*\n/).map((block) => {
    const props = Object.fromEntries(block.split('\n').map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }));
    return [props.Id, props];
  }));
  const auto = units['boot.automount'];
  const mount = units['boot.mount'];
  if (!auto || !mount) throw new Error('missing systemctl unit properties');
  const boot = mounts.trim().split('\n').map((l) => l.split(/\s+/)).filter((f) => f[1] === '/boot');
  const expired = auto.LoadState === 'loaded' && auto.ActiveState === 'active' &&
    mount.ActiveState === 'inactive' && boot.some((f) => f[2] === 'autofs') &&
    boot.every((f) => f[2] === 'autofs');
  return { expired, units, bootMounts: boot.map((f) => f.join(' ')) };
}

if (process.argv.includes('--report')) {
  const runs = path.join(STATE, 'runs');
  const ids = fs.readdirSync(runs).filter((id) => id.endsWith('--post-stage-idle')).sort();
  assert.equal(ids.length, 8);
  for (const id of ids) {
    const r = JSON.parse(fs.readFileSync(path.join(runs, id, 'post-stage-result.json')));
    const status = (text) => JSON.parse(text.split('\n').find((line) => line.startsWith('{'))).status;
    const staged = status(r.stagedStatus).staged.ostree.checksum;
    const booted = status(r.afterStatus).booted.ostree.checksum;
    assert.equal(r.error, undefined);
    assert.ok(r.elapsedSeconds >= WAIT_SECONDS);
    assert.equal(staged, booted);
    assert.notEqual(status(r.beforeStatus).booted.ostree.checksum, booted);
    assert.ok(r.bootedNew);
    assert.match(r.finalizeJournal, /Stopping ostree-finalize-staged.service/);
    assert.match(r.finalizeJournal, /Finalizing staged deployment/);
    assert.match(r.finalizeJournal, /ostree-finalize-staged.service: Deactivated successfully/);
    const units = r.beforeReboot.units;
    assert.equal(units['ostree-finalize-staged-hold.service'].SubState, 'running');
    console.log(`${id}: ${r.elapsedSeconds}s, automount=${units['boot.automount'].LoadState}, mount=${units['boot.mount'].ActiveState}, expired=${r.idleVerified}, booted=${booted}`);
  }
  console.log('Eight saved observations verified; this does not assert idle-out coverage.');
} else if (process.argv.includes('--test')) {
  const properties = 'Id=boot.automount\nLoadState=loaded\nActiveState=active\n\nId=boot.mount\nActiveState=inactive\n';
  const auto = 'systemd-1 /boot autofs rw 0 0\n';
  assert.equal(classify(`${properties}--- mounts ---\n${auto}`).expired, true);
  assert.equal(classify(`${properties}--- mounts ---\n${auto}/dev/vda3 /boot xfs ro 0 0\n`).expired, false);
  assert.equal(classify(`${properties}--- mounts ---\n`).expired, false);
  assert.equal(classify(`${properties.replace('LoadState=loaded', 'LoadState=not-found')}--- mounts ---\n${auto}`).expired, false);
  assert.throws(() => classify(properties), /missing/);
  console.log('snapshot classification: 5 assertions passed');
} else {
  // Import only the helpers, not the historical CLI. Fail closed if its entry
  // point changes; the immutable Git revision is part of the test provenance.
  const source = execFileSync('git', ['show', `${REVISION}:work/boot-2402/harness.mjs`], { encoding: 'utf8' });
  const entry = '\nmain().catch((e) => {';
  assert.equal(source.split(entry).length, 2);
  const helpers = source.slice(0, source.indexOf(entry)) + '\nexport { Vm, Evidence, qemuImg, PROBE, parseProbe, stepsFor, pool };';
  const { Vm, Evidence, qemuImg, PROBE, parseProbe, stepsFor, pool } = await import(`data:text/javascript;base64,${Buffer.from(helpers).toString('base64')}`);
  const results = [];
  const tasks = [];
  for (const image of ['fedora-bootc-44', 'centos-bootc-10']) {
    for (const variant of ['stock', 'pr3690-28854659']) {
      for (const firmware of ['bios', 'uefi']) {
        tasks.push(async () => {
          const name = `${image}--${variant}--root`;
          const id = `${name}--${firmware}--post-stage-idle`;
          const disk = JSON.parse(fs.readFileSync(path.join(STATE, 'disks', `${name}.json`)));
          const dir = path.join(STATE, 'runs', id);
          fs.mkdirSync(dir, { recursive: true });
          const overlay = path.join(dir, 'disk.qcow2');
          if (fs.existsSync(overlay)) throw new Error(`refusing to overwrite ${overlay}`);
          await qemuImg('create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', path.join(STATE, 'disks', `${name}.qcow2`), overlay);
          const vm = new Vm(id, dir, { firmware, disks: [{ file: overlay }] });
          const ev = new Evidence(path.join(dir, 'evidence.txt'));
          const r = { id, image, variant, firmware, startedAt: new Date().toISOString(), waitSeconds: WAIT_SECONDS };
          const cmd = (title, script) => ev.cmd(vm, title, script, { check: true });
          try {
            await vm.start();
            await vm.waitSsh();
            r.initial = parseProbe((await cmd('initial state', PROBE + '\ntrue')).out);
            await cmd('installed binary', 'ostree --version; sha256sum /usr/bin/ostree');
            const step = stepsFor(disk)[0];
            await vm.scpTo(step.prepare.local, step.prepare.remote);
            r.beforeStatus = (await cmd('before stage', 'ostree admin status; bootc status --json')).out;
            // Isolate post-stage idle from the earlier idle-before-stage bug.
            await cmd('mount before staging', 'ls /boot >/dev/null');
            await cmd('stage', step.stage);
            r.stagedStatus = (await cmd('staged deployment', 'ostree admin status; bootc status --json')).out;
            r.afterStage = classify((await cmd('start untouched interval', SNAPSHOT)).out);
            const start = Date.now();
            await new Promise((resolve) => setTimeout(resolve, WAIT_SECONDS * 1000));
            r.beforeReboot = classify((await cmd('end untouched interval', SNAPSHOT)).out);
            r.elapsedSeconds = (Date.now() - start) / 1000;
            r.idleVerified = r.beforeReboot.expired;
            // Reboot even when expiry was not observed, but never count that
            // result as strict idle-out coverage. Do not stop the hold service.
            await vm.reboot();
            r.finalizeJournal = (await cmd('shutdown finalize', 'journalctl -b -1 -o short-monotonic --no-pager -u ostree-finalize-staged.service -u ostree-finalize-staged-hold.service')).out;
            r.afterStatus = (await cmd('booted deployment', 'ostree admin status; bootc status --json')).out;
            r.bootedNew = (await ev.cmd(vm, 'update marker', step.verify)).code === 0;
          } catch (e) {
            r.error = e.message;
            ev.note(`ERROR: ${e.message}`);
          } finally {
            await vm.stop().catch((e) => { r.stopError = e.message; });
            fs.rmSync(overlay, { force: true });
            r.finishedAt = new Date().toISOString();
            fs.writeFileSync(path.join(dir, 'post-stage-result.json'), JSON.stringify(r, null, 2) + '\n');
          }
          results.push(r);
          console.log(`${id}: idleVerified=${r.idleVerified} bootedNew=${r.bootedNew} error=${r.error ?? 'none'}`);
        });
      }
    }
  }
  await pool(tasks, 8);
  // An unobserved expiry is incomplete coverage, not a passing strict test.
  if (results.length !== 8 || results.some((r) => r.error || !r.idleVerified || !r.bootedNew)) process.exitCode = 1;
}
