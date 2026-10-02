"""The egress policy for runner-sandbox (scripts/egress-proxy.mjs).

Reads are open: GET, HEAD and OPTIONS without a body go to any host not on
the threat feed. Anything else (POST, PUT, PATCH, DELETE, a WebSocket, a
read with a body) is a write, allowed only to the endpoints in policy.toml.
The host is the one the connection really goes to; a Host header or TLS
SNI naming another host (domain fronting) is refused. This module is plain
Python, so it is tested without mitmproxy (test_policy.py); addon.py
applies it to the proxy's flows.
"""

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
# What a WebSocket upgrade is matched as in policy.toml: once upgraded,
# frames go both ways, so it is a write.
WEBSOCKET = "WEBSOCKET"
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE", WEBSOCKET})


@dataclass(frozen=True)
class Decision:
    allowed: bool
    # Why: "read", a policy.toml rule's name, or the refusal.
    reason: str


def glob_regex(glob: str) -> re.Pattern:
    """A path glob as a regex: '*' is any run of characters but '/', '**'
    any run at all; everything else is literal."""
    parts = re.split(r"(\*\*|\*)", glob)
    body = "".join({"**": ".*", "*": "[^/]*"}.get(p, re.escape(p)) for p in parts)
    return re.compile(f"{body}\\Z")


def normalize_host(host: str) -> str:
    """HOST lowercased, without brackets, port or a trailing dot."""
    host = host.strip().lower()
    if host.startswith("["):
        host = host[1 : host.find("]")] if "]" in host else host[1:]
    elif host.count(":") == 1:
        host = host.split(":", 1)[0]
    return host.rstrip(".")


@dataclass(frozen=True)
class WriteRule:
    name: str
    hosts: frozenset
    methods: frozenset
    paths: tuple

    def matches(self, method: str, host: str, path: str) -> bool:
        return (method in self.methods and host in self.hosts
                and any(p.match(path) for p in self.paths))

    @classmethod
    def parse(cls, entry: dict) -> "WriteRule":
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError(f"a [[write]] rule needs a name: {entry}")
        for key in ("hosts", "methods", "paths"):
            value = entry.get(key)
            if not isinstance(value, list) or not value or not all(isinstance(v, str) and v for v in value):
                raise ValueError(f"[[write]] {name}: {key} must be a list of strings")
        unknown = set(entry) - {"name", "hosts", "methods", "paths", "why"}
        if unknown:
            raise ValueError(f"[[write]] {name}: unknown keys {sorted(unknown)}")
        methods = frozenset(m.upper() for m in entry["methods"])
        if not methods <= WRITE_METHODS:
            raise ValueError(f"[[write]] {name}: methods must be among {sorted(WRITE_METHODS)}")
        for path in entry["paths"]:
            if not path.startswith("/"):
                raise ValueError(f"[[write]] {name}: path '{path}' must start with /")
        hosts = frozenset(normalize_host(h) for h in entry["hosts"])
        return cls(name, hosts, methods, tuple(glob_regex(p) for p in entry["paths"]))


class Policy:
    def __init__(self, writes=(), denylist=frozenset()):
        self.writes = tuple(writes)
        self.denylist = frozenset(denylist)

    @classmethod
    def load(cls, policy_file: str, denylist_file: str = "") -> "Policy":
        with open(policy_file, "rb") as f:
            data = tomllib.load(f)
        unknown = set(data) - {"write"}
        if unknown:
            raise ValueError(f"{policy_file}: unknown tables {sorted(unknown)}")
        writes = [WriteRule.parse(e) for e in data.get("write", [])]
        denylist = read_denylist(Path(denylist_file)) if denylist_file else frozenset()
        return cls(writes, denylist)

    def denylisted(self, host: str) -> bool:
        """Whether HOST or a domain it is under is on the threat feed."""
        labels = normalize_host(host).split(".")
        return any(".".join(labels[i:]) in self.denylist for i in range(len(labels)))

    def connect(self, host: str) -> Decision:
        """A CONNECT to HOST: what goes through the tunnel is checked again,
        request by request."""
        if self.denylisted(host):
            return Decision(False, "host is on the threat feed")
        return Decision(True, "tunnel")

    def request(self, *, method: str, host: str, path: str, host_header: str | None = None,
                sni: str | None = None, has_body: bool = False, websocket: bool = False) -> Decision:
        """A request to HOST (where the connection goes)."""
        host = normalize_host(host)
        method = WEBSOCKET if websocket else method.upper()
        if self.denylisted(host):
            return Decision(False, "host is on the threat feed")
        if host_header and normalize_host(host_header) != host:
            return Decision(False, "the Host header names another host")
        if sni and normalize_host(sni) != host:
            return Decision(False, "the TLS server name names another host")
        if method in READ_METHODS and not has_body:
            return Decision(True, "read")
        path = path.split("?", 1)[0].split("#", 1)[0] or "/"
        for rule in self.writes:
            if rule.matches(method, host, path):
                return Decision(True, rule.name)
        what = "a read with a body" if method in READ_METHODS else method
        return Decision(False, f"{what} to an endpoint not in the write allowlist")


def read_denylist(path: Path) -> frozenset:
    """A domain list, one per line ('#' comments), as HaGeZi's wildcard
    feeds are: each entry covers its subdomains too."""
    with path.open(encoding="utf-8", errors="replace") as f:
        return frozenset(d for d in (normalize_host(line.split("#", 1)[0]) for line in f) if d)
