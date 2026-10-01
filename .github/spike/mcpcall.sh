#!/bin/bash
# As the sandbox user: call the safeoutputs MCP server through the gateway.
set -euo pipefail
cfg=/var/lib/runner-sandbox/temp/gh-aw/mcp-config/mcp-servers.json
url=$(jq -r .mcpServers.safeoutputs.url $cfg)
auth=$(jq -r .mcpServers.safeoutputs.headers.Authorization $cfg)
h=(-H "Authorization: $auth" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
sid=$(curl -sS -D - -o /dev/null "${h[@]}" "$url" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"spike","version":"0"}}}' | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}' | tr -d '\r')
echo "session=$sid"
H2=("${h[@]}"); [ -n "$sid" ] && H2+=(-H "Mcp-Session-Id: $sid")
curl -sS "${H2[@]}" "$url" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
curl -sS "${H2[@]}" "$url" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | sed -n "s/^data: //p" | jq -r ".result.tools[].name" | tr "\n" " "; echo
curl -sS "${H2[@]}" "$url" -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"${TOOL:-missing_tool}\",\"arguments\":${ARGS:-{\"tool\":\"spike-probe\",\"reason\":\"hello from runner-sandbox\"\}}}}" | head -c 400; echo
