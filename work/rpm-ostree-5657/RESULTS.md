# rpm-ostree-5657 results: RPM v6 importer (cgwalters-forge/rpm-ostree#15)

> This text is LLM generated.

## Verdict

PR #15's head, `f2b03ad3`, builds and passes `make check` unchanged in the
project's CI buildroot (Fedora 45, RPM 6.1.0). Its new test imports one
package built both as v4 (classic `070701` cpio) and v6 (stripped `07070X`
cpio) to identical OSTree trees. Comparing it against stock `main`
(`911dd734`) on real packages turned up one regression: packages that ship a
UNIX socket failed to import. Patch 0001 fixes it. The other patches gate the
test by architecture, add an opt-in 4 GiB test, and bump the unpack minor
version. With all four applied, 38 of 41 real Fedora 45 packages import to
byte-identical trees on `main` and the PR. The other three differ only by
#15's intentional setid change, described below.

Two findings are worth knowing beyond v6:

- `main` cannot import **v4** packages containing a file of 4 GiB or more,
  because rpmbuild already uses the stripped payload for those. #15 fixes this
  too.
- Errors are clearer: a corrupt payload now names the file and the payload
  compressor, not an OSTree zstd error.

## Patch series

Apply on top of #15's head `f2b03ad3` with `git am`. I checked that the four
patches apply cleanly to a fresh checkout and reproduce the tested tree.

1. `0001-importer-Skip-sockets-in-RPM-payloads.patch`: tar can't represent
   sockets, so the adapter failed with "pax format cannot archive sockets".
   `main` imported such packages, with OSTree dropping the socket like FIFOs
   and device nodes, so the adapter now skips sockets. The paired test package
   now ships a socket. Without the fix that test fails with the error above;
   with it, the v4 and v6 trees match `main`'s tree for the same v4 package.
2. `0002-tests-Build-the-importer-test-packages-natively.patch`: `build_rpm`
   defaults to `setarch x86_64`, which would break `make check` on other
   architectures. The patch builds for `uname -m`, skips the test when
   `rpmbuild` is missing, and drops an `%attr` on a symlink that rpmbuild
   warned about.
3. `0003-tests-Optionally-import-a-4-GiB-file-from-v4-and-v6-.patch`: setting
   `RPMOSTREE_TEST_LARGE_FILES=1` builds a package holding a 4 GiB + 5 byte
   file in both formats. The test checks the file's size and that both
   formats import to the same tree. It is opt-in because it took 56 s and
   over 8 GiB of temporary storage here.
4. `0004-importer-Bump-unpack-minor-version-for-the-librpm-re.patch`: bumps
   `rpmostree.unpack_minor_version` from 6 to 7, because cached content
   changes for setid files (see below). This was one of #15's open review
   items. Nothing reads this version today.

`scratch-import-dump.diff` is **not** part of the series. It is the throwaway
hook used for the comparisons below: it adds an `RPMOSTREE_DUMP_RPMS` /
`RPMOSTREE_DUMP_REPO` mode to `rpm-ostree testutils c-units` that imports
each RPM and prints its tree checksums. It applies to #15 with the series;
for `main` I made the equivalent edits by hand.

## What was built and run

The environment was the image `quay.io/coreos-assembler/fcos-buildroot:testing-devel`
(digest `sha256:96e07f79d7007213273cb70f0e66c3dfa5d389d5848a2c8f7e7870ba5c301ecd`),
with rpm 6.1.0, libarchive 3.8.9, libostree 2026.4 and clang-format 23.1.5.
`dnf builddep` on the spec found nothing missing. Rootless podman can't start
containers on this devspace, because `/proc` is mounted `hidepid=invisible`
and that breaks `newuidmap`. That is probably why #15's original run failed.
Unprivileged user namespaces do work, so I exported the image's root
filesystem and ran everything in a `chroot` under `unshare -Urm --pid --fork`.
Proxy and CA settings came from the host.

All results below are on the final head (#15 plus the four patches) unless
stated otherwise.

| Check | Result |
|---|---|
| `./autogen.sh && ./configure && make` on #15 unchanged | pass |
| `make check` on #15 unchanged | pass (c-units and v4/v6 importer test) |
| `make check` (42 s) | pass, 0 failures |
| `tests/check/test-importer.sh` with `RPMOSTREE_TEST_LARGE_FILES=1` (56 s) | pass |
| `cargo test` | pass (188 + 2 tests) |
| `ci/codestyle.sh` | exits 123, but only on `src/app/rpmostree-builtin-finalize-deployment.cxx`, which neither #15 nor this series touches (clang-format 23 is newer than upstream's). clang-format, tab, goto and rustfmt checks pass on every changed file. |
| v6 test package magic | v4 `070701`, v6 `07070X` (zstd), `RPMFORMAT` 4 and 6 |

### Comparison with stock `main`

I built `main` (`911dd734`) in the same buildroot, then imported each package
with both builds into a fresh bare-user repo and compared the root tree's
contents and metadata checksums. The 41 real packages came from the Fedora 45
repos (all v4; 40 zstd, 1 xz): bash, ca-certificates, coreutils,
cyrus-sasl-lib, dbus-daemon, firewalld, git-core, glibc, glibc-common,
glibc-langpack-en, iputils, kernel-core, libcap, linux-firmware-whence,
openssh-server, perl-interpreter, perl-libs, polkit, python3-libs,
shadow-utils, sudo, systemd, systemd-udev, tzdata, util-linux,
util-linux-core, vim-minimal, at, cronie, libutempter, lockdev, mutt,
openssh-keysign, plocate, postfix, procmail, screen, sendmail, slock, tmux and
xorg-x11-server-Xorg. These cover setuid and setgid binaries, file
capabilities, hardlinks, docs and many files.

| Input | `main` | #15 + series |
|---|---|---|
| 38 real packages | imported | identical trees |
| libutempter, lockdev, procmail | imported, setgid kept with build-host gid | imported, setgid dropped, see below |
| synthetic v4 packages (small; FIFO; `%dev` device; socket) | imported | identical trees |
| same packages as v6 | "Unrecognized archive format" | imported, identical to v4 |
| test package (hardlinks, non-ASCII name, caps, ghost, config, non-root owners) v4 / v6 | v4 imported; v6 fails | v4 == v6; differs from `main` only by the setid change |
| 4 GiB file, v4 and v6 | both fail, "Unrecognized archive format" | v4 == v6; file is 4294967302 bytes, ends in `tail\n` |
| corrupt or truncated zstd payload, v4 and v6 | v4: OSTree "Zstd decompression failed" / "Truncated zstd input"; v6: unrecognized | error naming the package, payload format, compressor and file |

Importing the first 27-package set took 2.6 s with `main` and 2.7 s with the
PR (single run, not a benchmark). Importing a 4 GiB file took about 7 s.

### The setid behavior change (intentional in #15)

#15 builds tar entries from the RPM header and imports every regular file as
root. When the header owner or group isn't root, it strips setuid or setgid,
so no root-owned setid file lands in the cache. `main` used the cpio's
numeric ids and mode instead. Those come from the *build host*: rpmbuild keeps
the bit and the numeric id when the account exists there, and strips it
otherwise. In the Fedora sample, libutempter (`02711 root:utmp`), lockdev
(`root:lock`) and procmail (`root:mail`) kept setgid with gids 22, 54 and 12
in `main`'s cache. With #15 they are cached as `0711`/`0755 root:root`.
plocate, postfix, screen and sendmail were already stripped by the build host
and match.

When composing or layering as root, this makes no difference to the
deployment. `apply_rpmfi_overrides` (`src/libpriv/rpmostree-core.cxx`) chowns
from the header's names and re-applies the header mode to regular files. It
returns early when `getuid() != 0`, so an **unprivileged** compose loses
these setgid bits where `main` kept them, with Fedora's fixed gids. Keeping
the bit with root ownership would be unsafe, and v6 payloads carry no numeric
ids at all. So I kept #15's design and bumped the unpack version (0004);
reviewers should decide whether this is acceptable. Directories keep the
header mode, setgid included, so the test package's `shared` directory is
`02770` with #15 and `0770` with `main`.

### Other review notes

The producer thread shares the package `Header` with the importer thread.
That is safe with RPM 6 (`nrefs` is `std::atomic_int`), and the importer
thread doesn't link or free the header during the import. Older RPM uses a
plain `int` refcount, so this relies on the same invariant. A producer error
is always reported, because `RpmOstreePayload::finish` runs after a
successful import. That matters because libarchive accepts a tar stream that
stops cleanly at a block boundary. If OSTree fails first, its own error wins
instead.

## Not done

- No build or test on CentOS Stream 9 or 10 (RPM 4.16 / 4.19). #15 uses
  `rpmfiNewArchiveReader` and related API from RPM 4.12+, but it was only
  compiled against RPM 6.1.
- No end-to-end `rpm-ostree compose` or client-side layering of a v6 package.
  So I did not exercise `apply_rpmfi_overrides`, SELinux labeling of imported
  content (the tests pass no sepolicy) or `--unified-core` here. Running as
  fake root in a one-uid user namespace can't chown to real gids.
- No real-world v6 packages: Fedora 45 still builds v4 by default, so all v6
  inputs were rebuilt synthetic packages.
- The bare-user test repo lives under `/tmp`, which is tmpfs here. CI's
  overlayfs `/tmp` was not tried.
- #15 still adds `BuildRequires: rpm-build` to the spec, which only CI's
  `builddep` needs since the spec has no `%check`. I left it unchanged.
