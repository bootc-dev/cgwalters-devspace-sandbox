// Fixtures for the safe-outputs tests: a real git repository, and the
// hand-back the agent step would make of a change to it.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import zlib from "node:zlib";
import { dirname, join } from "node:path";
import { buildPatch } from "../agent/handback.mjs";

export const REPO = "bootc-dev/bootc";
export const BASE = "main";

export function scratch() {
  return mkdtempSync(join(tmpdir(), "safe-outputs-test-"));
}

// git in DIR (hooks off, no user configuration), as handback.mjs's callers run it.
export function gitIn(dir) {
  return (args, { limit } = {}) => {
    const cmd = limit ? ["sh", "-c", `git "$@" | head -c ${limit}`, "sh"] : ["git"];
    const r = spawnSync(cmd[0], [...cmd.slice(1), "-C", dir, "-c", "core.hooksPath=/dev/null", ...args],
      { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, maxBuffer: 1 << 26 });
    return { status: r.status, stdout: r.stdout };
  };
}

export function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

// A repository with one commit of FILES (those named in EXECUTABLE are
// executable); returns {dir, git, base}.
export function repoWith(files = { "src/lib.rs": "fn main() {}\n" }, executable = []) {
  const dir = scratch();
  const git = gitIn(dir);
  git(["init", "-q", "-b", BASE]);
  write(dir, files);
  for (const name of executable) chmodSync(join(dir, name), 0o755);
  git(["add", "--all"]);
  git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "init"]);
  const base = git(["rev-parse", "HEAD"]).stdout.toString().trim();
  return { dir, git, base };
}

// The patch of CHANGE (a function that edits the repository's tree).
export function patchOf(change, files, executable) {
  const repo = repoWith(files, executable);
  change(repo.dir);
  const built = buildPatch(repo.git, repo.base, "Change things", 1 << 20);
  return { ...repo, ...built };
}

// A zip file of ENTRIES ({name, data, method: "stored" | "deflate", unixMode,
// claimedSize}), as upload-artifact's zips are shaped: local headers,
// then the central directory, which carries the sizes.
export function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, method = "deflate", unixMode, claimedSize } of entries) {
    const body = Buffer.from(data);
    const packed = method === "stored" ? body : zlib.deflateRawSync(body);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method === "stored" ? 0 : 8, 8);
    local.writeUInt32LE(zlib.crc32(body), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt8(unixMode === undefined ? 0 : 3, 5);
    cd.writeUInt16LE(method === "stored" ? 0 : 8, 10);
    cd.writeUInt32LE(zlib.crc32(body), 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(claimedSize ?? body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(unixMode === undefined ? 0 : (unixMode << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
