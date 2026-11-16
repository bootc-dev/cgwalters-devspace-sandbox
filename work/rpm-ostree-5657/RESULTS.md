# rpm-ostree-5657: building and testing the RPM v6 importer draft

> This text is LLM generated.

This covers [cgwalters-forge/rpm-ostree#15](https://github.com/cgwalters-forge/rpm-ostree/pull/15)
("importer: Decode RPM payloads with librpm"), head `f2b03ad3de08bf73136fc4361f44273caea158d7`,
for upstream rpm-ostree issue 5657. Testing ran on 2026-11-16.

## Verdict

PR #15 builds, and `make check` passes, including its own paired v4/v6 importer
test. On this corpus it fixes the reported bug: `main` can't import v6 packages,
or v4 packages containing a file over 4 GiB, and PR #15 imports both.
Comparing imports by `main` and by PR #15 turned up one regression: any package
containing a socket failed to import. [`patches/0001`](patches/0001-importer-Skip-sockets-in-the-payload-adapter.patch)
fixes it and extends the test to catch it. [`patches/0002`](patches/0002-tests-Build-the-payload-test-package-as-noarch.patch)
builds the test package as noarch, because the test as written only passes on x86_64.
Apply both with `git am patches/*.patch` on top of `f2b03ad3`. They apply cleanly
and reproduce the tree tested below exactly.

## Environment

The CI buildroot `quay.io/coreos-assembler/fcos-buildroot:testing-devel`
(`sha256:8de24dd76f263b12dfca19e72d3584bb396c25b700699bb0fbf31c1a8beef7db`):
Fedora 45, rpm 6.1.0, ostree 2026.4, libarchive 3.8.9, gcc 16.2.1, cargo 1.100.0.
Its `_rpmformat` defaults to 4, so v6 packages have to be requested with
`--define "_rpmformat 6"`, which the test does.

Rootless podman can't run containers in this sandbox: `/proc` hides other
processes, so `newuidmap` fails. [`upodman.sh`](upodman.sh) can still pull the
image, but running it fails in crun. So everything ran in a chroot of the image's
unpacked rootfs, as uid 0 of a single-uid user namespace ([`uchroot.sh`](uchroot.sh)).
`ci/installdeps.sh` reported nothing to install.

## What was built and tested

| Check | Result |
|---|---|
| PR #15 build (`ci/build.sh` flags, without `--enable-werror`) | pass, no warnings in the changed files |
| PR #15 `make check` (libglnx, Rust unit tests, `c-units`, `test-importer.sh`) | pass |
| Paired-package import, `main` against PR #15, 26 Fedora 45 packages plus 4 synthetic ones | one regression (sockets), see below |
| New socket/FIFO/device test on PR #15 without 0001 | fails as expected ("pax format cannot archive sockets") |
| Same test with 0001 | pass |
| `make check` on PR #15 + 0001 + 0002 (final tree) | pass, 43 s incremental |
| clang-format 23.1.5 on the changed files | clean, as on `main` |

### Paired import comparison

[`harness-import-dump.patch`](harness-import-dump.patch) (for PR #15) and
[`harness-import-dump-main.patch`](harness-import-dump-main.patch) (for `main`)
add a test-only hook to `rpm-ostree testutils c-units`. It imports a list of RPMs
into a bare-user repository with empty importer flags. [`import-compare.sh`](import-compare.sh)
runs it and lists each resulting tree with `ostree ls -R -X` for diffing.

The corpus was 26 Fedora 45 packages chosen for setuid/setgid files, file
capabilities, non-root owners, hardlinks and size: at, coreutils, cronie,
dbus-daemon, filesystem, fping, git-core, glibc, iputils, kernel-core,
kernel-modules-core, libcap, libutempter, openssh-clients, openssh-server,
plocate, polkit, postfix, screen, setup, shadow-utils, sudo, systemd, tcpdump,
util-linux-core and wireshark-cli. All are v4, 24 with zstd and 2 with xz payloads.
The synthetic packages come from [`payload-special.spec`](payload-special.spec), each
built as v4 and v6: one with a FIFO, a socket and a `%dev` character device, and
a `-large` variant that adds a 4 GiB + 5 byte file.

- **Real packages:** 24 of the 25 that `main` imports give identical trees and
  identical commit checksums with PR #15. `filesystem` fails identically on both
  (`/afs` is an unsupported path without the compose filters).
- **libutempter:** `/usr/libexec/utempter/utempter` is `02711 0:22` on `main`
  and `00711 0:0` on PR #15. That is the change PR #15 documents (setid bits for
  non-root owners are dropped from the cache). On `main` it depended on the build
  host: rpm's cpio writer already drops setgid when the group doesn't exist there,
  as with postfix's `postdrop` and `plocate`, which are `0755 0:0` on both. It
  keeps setgid with the host's numeric gid when the group does exist, as with
  `utmp`. In root assembly, `apply_rpmfi_overrides()` (`src/libpriv/rpmostree-core.cxx`)
  chowns and chmods every such file from the header, so the deployed result is
  the same. Unprivileged assembly skips that function on both branches.
- **v6 and stripped payloads:** `main` fails with "Reading rpm2cpio: Unrecognized
  archive format" on both v6 packages and on the **v4** `-large` package. RPM
  already uses the stripped payload for files over 4 GiB, so this bug is older
  than v6. PR #15 with 0001 imports all four. The v4 and v6 trees match
  (`ostree ls -RCX`), and the large file's content SHA-256 matches the expected
  `47b813df…b6a6a3`. The v4 special package without the large file matches
  `main`'s tree.
- **Sockets:** PR #15 fails every special package with "Writing payload header:
  ./usr/share/payload-special/socket: pax format cannot archive sockets". `main`
  imported the v4 one, skipping the socket, FIFO and device as unsupported content.
  0001 skips sockets in the adapter. FIFOs and devices pass through tar and are
  skipped by OSTree as before.
- **Speed:** the 26-package corpus (121 MB) imports in 2–3 s on both builds,
  twice each, timed with one-second resolution. Both large packages and the
  corpus together took 16 s with PR #15.

## Not done

- **Sanitizers:** `--enable-sanitizers` fails to link on this buildroot, in the
  Rust test binaries and generated cxx code, even with `RUSTFLAGS` linking
  ASan/UBSan. This is not specific to PR #15, so the importer threads were not
  run under ASan or TSan.
- **`--enable-werror`:** fails on three `-Wmaybe-uninitialized` warnings in
  generated `rpmostree-cxxrs.cxx` with gcc 16. `main` has the same three.
- **Repository-wide `ci/codestyle.sh`:** clang-format 23 reports violations in
  many files PR #15 doesn't touch. The changed files are clean.
- **End-to-end:** no compose, client-side layering, vmcheck or kola run with a v6
  package. Only the importer was exercised, so `apply_rpmfi_overrides()` restoring
  setid bits was established by reading the code, not by running it.
- **Large files in `make check`:** the >4 GiB case was tested by hand as described
  above. Building and importing the v4 and v6 pair took most of a minute and
  over 8 GiB of scratch space, so it isn't in the test suite.
- **Other architectures:** 0002 makes the test arch-independent, but it only ran
  on x86_64.
- **Unpack version:** PR #15's review left a bump of `rpmostree.unpack_minor_version`
  open. Nothing reads that value, and cached commits differ only where `main`'s
  were host-dependent (above), so these patches don't bump it.

## Notes for the forge fix run

PR #15's commit message says "the full build and make check could not run here".
Its body says the adapter "spools an uncompressed tar to an anonymous temporary
file", but the code streams the tar over a socketpair and buffers only one
hardlinked file's content at a time. Both should be updated when 0001 and 0002
are applied. The commit message also lists skipping socket entries and gating the
test on x86_64 as open items, and these patches close both.

## Reproducing

```console
R5657=/var/tmp/r5657 bash upodman.sh pull quay.io/coreos-assembler/fcos-buildroot:testing-devel
# copy the image's top vfs layer (/var/tmp/r5657/pm/storage/vfs/dir/<id>) to a rootfs, using unshare -r cp -a
bash uchroot.sh ROOTFS RPM_OSTREE_CHECKOUT bash -c 'ci/installdeps.sh && . ci/libbuild.sh && build --enable-installed-tests --enable-bin-unit-tests && make check'
# paired comparison: apply a harness patch, rebuild, then with the RPMs and import-compare.sh in DATA
R5657_DATA=DATA bash uchroot.sh ROOTFS RPM_OSTREE_CHECKOUT bash /data/import-compare.sh NAME
```
