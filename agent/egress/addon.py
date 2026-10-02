"""mitmproxy addon: applies policy.py to every request runner-sandbox sends
through the egress proxy, refusing with a 403 that says why, and appends
one JSON line per request to the access log. The log holds the method,
host, port, path (without the query string) and outcome: never headers,
bodies or query strings, where credentials travel.

Run it with rawtcp=false: then mitmproxy parses whatever goes through a
CONNECT tunnel as HTTP and refuses anything else, which would be a write
channel the policy can't see.
"""

import json
import os
import sys
from datetime import datetime, timezone

from mitmproxy import ctx, exceptions, http

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from policy import READ_METHODS, Decision, Policy  # noqa: E402

# Longest path kept in the log.
MAX_LOGGED_PATH = 200
# On every refusal, so clients and checks can tell it from the server's.
DENIED_HEADER = "X-Egress-Denied"
LOGGED = "egress_logged"


def has_body_headers(headers) -> bool:
    length = headers.get("content-length", "").strip()
    return (length not in ("", "0")) or "transfer-encoding" in headers


class Egress:
    def __init__(self):
        self.policy = Policy()
        self.log = None

    def load(self, loader):
        loader.add_option("egress_policy", str, "", "policy.toml: the endpoints writes may go to")
        loader.add_option("egress_denylist", str, "", "Threat feed: domains refused, one per line")
        loader.add_option("egress_log", str, "", "The access log, appended as JSON lines")

    def configure(self, updated):
        if updated & {"egress_policy", "egress_denylist"}:
            if not ctx.options.egress_policy:
                raise exceptions.OptionsError("egress_policy is required")
            try:
                self.policy = Policy.load(ctx.options.egress_policy, ctx.options.egress_denylist)
            except (OSError, ValueError) as e:
                raise exceptions.OptionsError(f"egress policy: {e}") from e
        if "egress_log" in updated and ctx.options.egress_log:
            self.log = open(ctx.options.egress_log, "a", buffering=1, encoding="utf-8")

    def record(self, *, decision: str, reason: str, method: str, scheme: str, host: str, port: int,
               path: str = "", status: int | None = None, error: str | None = None):
        entry = {
            "time": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "decision": decision, "reason": reason, "method": method, "scheme": scheme,
            "host": host, "port": port, "path": path.split("?", 1)[0][:MAX_LOGGED_PATH],
            "status": status, "error": error,
        }
        if self.log:
            self.log.write(json.dumps(entry) + "\n")

    def record_flow(self, flow: http.HTTPFlow, decision: str, reason: str, error: str | None = None):
        req = flow.request
        self.record(decision=decision, reason=reason, method=req.method, scheme=req.scheme, host=req.host,
                    port=req.port, path="" if req.method == "CONNECT" else req.path,
                    status=flow.response.status_code if flow.response else None, error=error)
        flow.metadata[LOGGED] = True

    def deny(self, flow: http.HTTPFlow, d: Decision):
        # mitmproxy can't answer a request it streams: the refused body is
        # read to the end, and dropped.
        flow.request.stream = False
        flow.response = http.Response.make(
            403, f"refused by the egress proxy: {d.reason}\n",
            {"Content-Type": "text/plain; charset=utf-8", DENIED_HEADER: d.reason})
        self.record_flow(flow, "deny", d.reason)

    def http_connect(self, flow: http.HTTPFlow):
        d = self.policy.connect(flow.request.host)
        if not d.allowed:
            self.deny(flow, d)

    def requestheaders(self, flow: http.HTTPFlow):
        req = flow.request
        websocket = req.headers.get("upgrade", "").strip().lower() == "websocket"
        d = self.policy.request(method=req.method, host=req.host, path=req.path, host_header=req.host_header,
                                sni=flow.client_conn.sni, has_body=has_body_headers(req.headers),
                                websocket=websocket)
        flow.metadata["egress_reason"] = d.reason
        if not d.allowed:
            self.deny(flow, d)
        elif req.method.upper() in READ_METHODS:
            # Buffered, so request() sees a body the headers didn't announce
            # (HTTP/2 needs neither Content-Length nor chunking).
            req.stream = False

    def request(self, flow: http.HTTPFlow):
        req = flow.request
        if flow.response is None and req.method.upper() in READ_METHODS and req.raw_content:
            self.deny(flow, Decision(False, "a read with a body to an endpoint not in the write allowlist"))

    def responseheaders(self, flow: http.HTTPFlow):
        # Responses are never inspected, so they stream through: downloads
        # (crates, container layers) can be big. Requests aren't streamed:
        # the policy needs to see a read's whole body, and refusing one
        # means answering it.
        if not flow.metadata.get(LOGGED):
            flow.response.stream = True

    def response(self, flow: http.HTTPFlow):
        if not flow.metadata.get(LOGGED):
            self.record_flow(flow, "allow", flow.metadata.get("egress_reason", "read"))

    def error(self, flow: http.HTTPFlow):
        if not flow.metadata.get(LOGGED):
            self.record_flow(flow, "allow", flow.metadata.get("egress_reason", "read"),
                             error=flow.error.msg if flow.error else None)



addons = [Egress()]
