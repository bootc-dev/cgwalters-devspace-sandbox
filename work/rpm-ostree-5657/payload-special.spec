# Special entries and an optional >4 GiB file, built once per payload format:
#   rpmbuild -bb --define "_rpmformat 6" [--define "large 1"] payload-special.spec
Name: payload-special%{?large:-large}
Version: 1.0
Release: 1
Summary: Payload adapter test package
License: MIT
BuildArch: noarch
%global __os_install_post %{nil}
%global _binary_payload w19.zstdio

%description
%{summary}.

%install
mkdir -p %{buildroot}/usr/share/payload-special
mkfifo %{buildroot}/usr/share/payload-special/fifo
python3 -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' %{buildroot}/usr/share/payload-special/socket
echo after > %{buildroot}/usr/share/payload-special/zz-after-specials
%if 0%{?large}
truncate -s 4G %{buildroot}/usr/share/payload-special/large
echo tail >> %{buildroot}/usr/share/payload-special/large
%endif

%files
/usr/share/payload-special
%dev(c,1,3) /usr/share/payload-special-null
