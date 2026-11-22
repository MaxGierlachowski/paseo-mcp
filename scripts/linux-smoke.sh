#!/usr/bin/env bash
# Headless Linux smoke test of a release tarball against a real Paseo daemon, the way agentbox
# installs it: daemon on 127.0.0.1 with relay and web UI off, the plugin installed from the unpacked
# tarball, HTTP server, tokens and a webhook from the managed settings file, then
#   - the plugin's HTTP MCP endpoint (initialize, tools/list per scope, 401, agents, events,
#     a permission round trip) on an echo ACP provider that needs no model account,
#   - a signed webhook delivery with origin_ref,
#   - the stdio server (smoke.mjs from the tarball) against the same daemon.
#
# Usage: scripts/linux-smoke.sh dist/paseo-mcp-<version>.tgz
# Needs node >= 22 with npm, curl and tar. Installs @getpaseo/cli@$PASEO_VERSION (default 0.17.3)
# into a temporary prefix unless PASEO_BIN points at a paseo binary. KEEP_WORK=1 keeps the temp dir.
set -euo pipefail

TARBALL=$(cd "$(dirname "${1:?usage: linux-smoke.sh <paseo-mcp-x.y.z.tgz>}")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "$0")" && pwd)
PASEO_VERSION=${PASEO_VERSION:-0.17.3}
DAEMON_PORT=${DAEMON_PORT:-6767}
MCP_PORT=${MCP_PORT:-6790}
RECEIVER_PORT=${RECEIVER_PORT:-8799}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/paseo-mcp-smoke.XXXXXX")
export PASEO_HOME="$WORK/paseo-home"
mkdir -p "$PASEO_HOME" "$WORK/work"
DAEMON_PID=""
RECEIVER_PID=""

say() { printf '\n== %s\n' "$*"; }
cleanup() {
  status=$?
  set +e
  if [ -n "$DAEMON_PID" ]; then kill "$DAEMON_PID" 2>/dev/null; wait "$DAEMON_PID" 2>/dev/null; fi
  if [ -n "$RECEIVER_PID" ]; then kill "$RECEIVER_PID" 2>/dev/null; fi
  if [ "$status" -ne 0 ]; then
    echo "!! smoke test failed ($status); daemon log tail:" >&2
    tail -n 80 "$WORK/daemon.log" >&2 2>/dev/null || true
    [ -n "${PASEO_BIN:-}" ] && "$PASEO_BIN" plugin logs paseo-mcp 2>/dev/null | tail -n 40 >&2 || true
  fi
  if [ "${KEEP_WORK:-0}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
  exit "$status"
}
trap cleanup EXIT

wait_for() { # description, command...
  local what=$1; shift
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $what" >&2
  return 1
}

say "Paseo CLI $PASEO_VERSION"
if [ -z "${PASEO_BIN:-}" ]; then
  npm install --global --prefix "$WORK/cli" "@getpaseo/cli@$PASEO_VERSION" --no-audit --no-fund --loglevel=error
  PASEO_BIN="$WORK/cli/bin/paseo"
fi
paseo() { "$PASEO_BIN" "$@"; }
paseo --version
node --version

say "Daemon config (PASEO_HOME=$PASEO_HOME)"
paseo daemon config set daemon.listen "127.0.0.1:$DAEMON_PORT" --home "$PASEO_HOME"
paseo daemon config set daemon.relay.enabled false --home "$PASEO_HOME"
paseo daemon config set features.webUi.enabled false --home "$PASEO_HOME"
paseo daemon config set daemon.mcp.injectIntoAgents true --home "$PASEO_HOME"
paseo daemon config set daemon.browserTools.enabled false --home "$PASEO_HOME"
paseo daemon config set pluginsEnabled true --home "$PASEO_HOME"
# A model-free provider so agents, turns and permissions can be exercised without an account.
node -e '
  const fs = require("fs"), f = process.argv[1];
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.agents ??= {}; c.agents.providers ??= {};
  c.agents.providers.echo = { extends: "acp", label: "Echo", command: [process.execPath, process.argv[2]],
    models: [{ id: "echo", label: "Echo", isDefault: true }] };
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
' "$PASEO_HOME/config.json" "$HERE/smoke/echo-acp.mjs"
cat "$PASEO_HOME/config.json"

say "Start the daemon"
if curl -fsS -o /dev/null "http://127.0.0.1:$DAEMON_PORT/api/health" 2>/dev/null; then
  echo "something already answers on 127.0.0.1:$DAEMON_PORT; set DAEMON_PORT" >&2
  exit 1
fi
paseo daemon run --home "$PASEO_HOME" >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!
wait_for "daemon health" curl -fsS "http://127.0.0.1:$DAEMON_PORT/api/health"
# The CLI finds the daemon through $PASEO_HOME/paseo.pid, which can lag behind the health route.
wait_for "daemon status" sh -c "'$PASEO_BIN' daemon status | grep -q 'localDaemon: running'"
kill -0 "$DAEMON_PID"
curl -fsS "http://127.0.0.1:$DAEMON_PORT/api/health"; echo

say "Unpack and install the plugin"
mkdir -p "$WORK/vendor"
tar -xzf "$TARBALL" -C "$WORK/vendor"
PM="$WORK/vendor/paseo-mcp"
ls "$PM"
paseo plugin install "$PM"
paseo plugin ls paseo-mcp
wait_for "plugin running" sh -c "'$PASEO_BIN' plugin ls paseo-mcp --json | grep -q '\"status\": *\"running\"'"
paseo plugin ls paseo-mcp --json

say "Tokens and managed settings, non-interactive"
node "$PM/dist/admin.js" token create --label hermes-ui --scope full --origin hermes --out "$WORK/token-full"
node "$PM/dist/admin.js" token create --label bridge --scope read --label-filter origin=hermes --out "$WORK/token-read"
WEBHOOK_SECRET="whsec_$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64"))')"
node -e '
  const fs = require("fs"), [f, roots, port, hook, secret] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  Object.assign(m, {
    http: { enabled: true, port: Number(port), bind: "127.0.0.1" },
    allowedRoots: [roots],
    originLabel: "hermes",
    webhooks: [{ id: "bridge", label: "bridge", url: hook, signature: "standard-webhooks", secret,
                 types: ["agent.turn_ended", "agent.permission_requested"], labels: { origin: "hermes" } }],
  });
  fs.writeFileSync(f, JSON.stringify(m, null, 2), { mode: 0o600 });
' "$(node "$PM/dist/admin.js" path)" "$WORK/work" "$MCP_PORT" "http://127.0.0.1:$RECEIVER_PORT/webhooks/paseo" "$WEBHOOK_SECRET"
node "$PM/dist/admin.js" check
node "$PM/dist/admin.js" token list

say "Webhook receiver"
RECEIVER_SECRET="$WEBHOOK_SECRET" RECEIVER_LOG="$WORK/deliveries.jsonl" node "$HERE/smoke/receiver.mjs" "$RECEIVER_PORT" &
RECEIVER_PID=$!

say "HTTP MCP endpoint http://127.0.0.1:$MCP_PORT/mcp"
mcp_init() {
  curl -sS -o "$WORK/init.out" -w '%{http_code}' -X POST "http://127.0.0.1:$MCP_PORT/mcp" \
    -H "Authorization: Bearer $(cat "$WORK/token-full")" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
}
wait_for "HTTP endpoint" sh -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:$MCP_PORT/mcp)\" = 401 ]"
code=$(mcp_init); echo "initialize -> HTTP $code"; cat "$WORK/init.out"; echo
[ "$code" = 200 ]
PM_DIR="$PM" MCP_URL="http://127.0.0.1:$MCP_PORT/mcp" TOKEN_FULL="$(cat "$WORK/token-full")" \
  TOKEN_READ="$(cat "$WORK/token-read")" WORK_DIR="$WORK/work" node "$HERE/smoke/check-http.mjs"

say "Webhook deliveries"
wait_for "a turn_ended delivery" grep -q 'agent.turn_ended' "$WORK/deliveries.jsonl"
cat "$WORK/deliveries.jsonl"
if grep -q '"verified":false' "$WORK/deliveries.jsonl"; then echo "unverified delivery" >&2; exit 1; fi
grep -q '"origin_ref":"smoke-session-1"' "$WORK/deliveries.jsonl"
grep -q 'agent.permission_requested' "$WORK/deliveries.jsonl"

say "Revoking a token takes effect without a restart"
node "$PM/dist/admin.js" token revoke bridge
wait_for "revoked token rejected" sh -c "! PM_DIR='$PM' node -e '
  const t = process.argv[1];
  fetch(\"http://127.0.0.1:$MCP_PORT/mcp\", { method: \"POST\", headers: { Authorization: \"Bearer \" + t, \"Content-Type\": \"application/json\", Accept: \"application/json, text/event-stream\" },
    body: JSON.stringify({ jsonrpc: \"2.0\", id: 1, method: \"initialize\", params: { protocolVersion: \"2025-06-18\", capabilities: {}, clientInfo: { name: \"x\", version: \"0\" } } }) })
    .then((r) => process.exit(r.status === 200 ? 0 : 1))' '$(cat "$WORK/token-read")'"

say "stdio server from the tarball (smoke.mjs)"
cat >"$WORK/stdio-config.json" <<JSON
{
  "daemonUrl": "ws://127.0.0.1:$DAEMON_PORT/ws",
  "allowedRoots": ["$WORK/work"],
  "originLabel": "hermes",
  "defaultProvider": "echo",
  "accounts": {},
  "events": { "enabled": true }
}
JSON
(cd "$WORK" && env -i PATH="$PATH" HOME="$WORK" PASEO_HOME="$PASEO_HOME" PASEO_MCP_CONFIG="$WORK/stdio-config.json" \
  node "$PM/smoke.mjs" 'paseo_list_agents={"include_archived":true}' paseo_list_accounts \
  "paseo_create_agent={\"cwd\":\"$WORK/work\",\"prompt\":\"hello over stdio\",\"labels\":{\"origin_ref\":\"stdio-1\"}}" \
  'paseo_wait_for_events={"timeout_sec":0}' 'paseo_list_agents={"labels":{"origin_ref":"stdio-1"}}') | tee "$WORK/stdio.out"
grep -q '^TOOLS (11)' "$WORK/stdio.out"
grep -q 'stdio-1' "$WORK/stdio.out"

say "Plugin log"
paseo plugin logs paseo-mcp | tail -n 20

echo
echo "LINUX SMOKE OK ($(node -p 'process.platform + "-" + process.arch'), paseo $PASEO_VERSION)"
