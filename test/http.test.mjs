// Integration test: the HTTP server on a free port, real MCP clients over Streamable HTTP,
// and a stub in place of the Paseo daemon. Run after `npm run build`.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { newToken } from "../dist/auth.js";
import { startHttpServer } from "../dist/http.js";
import { registerTools } from "../dist/tools.js";

const config = {
  allowedRoots: ["/nonexistent-root"],
  accounts: { work: { configDir: "~/.claude-work" } },
  defaultAccount: "work",
  accountEnvVar: "CLAUDE_CONFIG_DIR",
  originLabel: "test",
  readOnly: false,
};

const agent = {
  id: "agent-1234",
  title: "Stub agent",
  status: "idle",
  requiresAttention: false,
  provider: "claude",
  model: "sonnet",
  cwd: "/tmp",
  labels: { origin: "test" },
  pendingPermissions: [],
  updatedAt: "2026-11-08T10:00:00Z",
  lastUserMessageAt: null,
};

// Only what the read tools touch.
const paseo = {
  agents: {
    async list() {
      return { entries: [{ agent }], pageInfo: { nextCursor: null } };
    },
  },
};

const read = newToken({ label: "reader", scope: "read" });
const full = newToken({ label: "writer", scope: "full" });
const doomed = newToken({ label: "doomed", scope: "full" });
let tokens = [read.record, full.record, doomed.record];
const used = [];
let server;

before(async () => {
  server = await startHttpServer({
    bind: "127.0.0.1",
    port: 0,
    tokens: () => tokens,
    onTokenUsed: (t) => used.push(t.id),
    createMcpServer: (token) => {
      const s = new McpServer({ name: "paseo", version: "test" });
      registerTools(s, { config: () => config, paseo: async () => paseo, scope: token.scope });
      return s;
    },
    maxBodyBytes: 64 * 1024,
  });
});

after(async () => {
  await server?.close();
});

async function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

function post(headers, body = initialize, path = "/mcp") {
  return fetch(new URL(path, server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body,
  });
}

test("listens on loopback with /mcp", () => {
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
});

test("no token: 401 with WWW-Authenticate", async () => {
  const res = await post({});
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
});

test("wrong token: 401", async () => {
  const res = await post({ authorization: "Bearer pmcp_wrong" });
  assert.equal(res.status, 401);
});

test("the client transport without a token is refused", async () => {
  const client = new Client({ name: "test", version: "0.0.1" });
  await assert.rejects(client.connect(new StreamableHTTPClientTransport(new URL(server.url))));
});

test("foreign Origin is refused even with a valid token", async () => {
  const res = await post({ authorization: `Bearer ${full.token}`, origin: "http://evil.example" });
  assert.equal(res.status, 403);
});

test("foreign Host is refused even with a valid token", async () => {
  const port = new URL(server.url).port;
  // fetch sets Host itself; use node:http to send a rebinding-style Host.
  const { request } = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: `evil.example:${port}`, authorization: `Bearer ${full.token}`, "content-type": "application/json" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end(initialize);
  });
  assert.equal(status, 403);
});

test("other paths are 404", async () => {
  const res = await post({ authorization: `Bearer ${full.token}` }, initialize, "/other");
  assert.equal(res.status, 404);
});

test("oversized bodies are refused with 413", async () => {
  const res = await post({ authorization: `Bearer ${full.token}` }, JSON.stringify({ pad: "x".repeat(70 * 1024) }));
  assert.equal(res.status, 413);
});

test("invalid JSON is 400", async () => {
  const res = await post({ authorization: `Bearer ${full.token}` }, "{not json");
  assert.equal(res.status, 400);
});

test("read token sees the 5 read tools", async () => {
  const client = await connect(read.token);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "paseo_get_agent",
    "paseo_list_accounts",
    "paseo_list_agents",
    "paseo_list_models",
    "paseo_read_timeline",
  ]);
  await client.close();
});

test("full token sees all 10 tools", async () => {
  const client = await connect(full.token);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  assert.ok(tools.some((t) => t.name === "paseo_create_agent"));
  assert.ok(tools.some((t) => t.name === "paseo_respond_permission"));
  await client.close();
});

test("a read tool call works and a write tool is not callable with a read token", async () => {
  const client = await connect(read.token);
  const r = await client.callTool({ name: "paseo_list_agents", arguments: { limit: 5 } });
  assert.ok(!r.isError);
  const data = JSON.parse(r.content[0].text);
  assert.equal(data.count, 1);
  assert.equal(data.agents[0].id, "agent-1234");
  const w = await client.callTool({ name: "paseo_archive_agent", arguments: { agent_id: "agent-1234" } });
  assert.ok(w.isError);
  await client.close();
});

test("allowedRoots is enforced server side for full tokens", async () => {
  const client = await connect(full.token);
  const r = await client.callTool({ name: "paseo_create_agent", arguments: { cwd: "/tmp", prompt: "hi", provider: "claude/x" } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /outside allowedRoots/);
  await client.close();
});

test("sessions are bound to their token", async () => {
  const client = await connect(full.token);
  const sessionId = client.transport.sessionId;
  assert.ok(sessionId);
  const res = await post(
    { authorization: `Bearer ${read.token}`, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  );
  assert.equal(res.status, 404);
  await client.close();
});

test("token use is reported", () => {
  assert.ok(used.includes(read.record.id));
  assert.ok(used.includes(full.record.id));
});

test("revoking a token: 401 at once and its open sessions are closed", async () => {
  const client = await connect(doomed.token);
  assert.equal(server.sessionCount(doomed.record.id), 1);
  const keep = await connect(full.token);
  const fullBefore = server.sessionCount(full.record.id);

  tokens = tokens.filter((t) => t.id !== doomed.record.id);
  const closed = await server.closeSessions((id) => id === doomed.record.id);
  assert.equal(closed, 1);
  assert.equal(server.sessionCount(doomed.record.id), 0);
  assert.equal(server.sessionCount(full.record.id), fullBefore);

  await assert.rejects(client.listTools());
  assert.equal((await post({ authorization: `Bearer ${doomed.token}` })).status, 401);
  // Other tokens keep working.
  assert.equal((await keep.listTools()).tools.length, 10);
  await keep.close();
});

test("a taken port is reported, not thrown later", async () => {
  const port = Number(new URL(server.url).port);
  await assert.rejects(
    startHttpServer({ bind: "127.0.0.1", port, tokens: () => [], createMcpServer: () => new McpServer({ name: "x", version: "0" }) }),
    (e) => e.code === "EADDRINUSE" && /already in use/.test(e.message),
  );
});
