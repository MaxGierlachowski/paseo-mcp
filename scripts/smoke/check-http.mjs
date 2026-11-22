#!/usr/bin/env node
// Drives the plugin's HTTP MCP endpoint like a client (hermes-ui, a bridge) would, against a real
// headless daemon with the echo ACP provider: tools per scope, create an agent with an origin_ref,
// events with a cursor, a permission round trip, and the 401 without a token.
//
// Env: PM_DIR (unpacked tarball, its node_modules provide the MCP SDK), MCP_URL, TOKEN_FULL,
// TOKEN_READ, WORK_DIR (an allowed root), PROVIDER (default "echo").
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { PM_DIR, MCP_URL, TOKEN_FULL, TOKEN_READ, WORK_DIR } = process.env;
const PROVIDER = process.env.PROVIDER ?? "echo";
const sdk = (p) => import(pathToFileURL(join(PM_DIR, "node_modules/@modelcontextprotocol/sdk/dist/esm", p)).href);
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");

const step = (m) => console.log(`-- ${m}`);
async function connect(token) {
  const client = new Client({ name: "linux-smoke", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}
async function callText(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text ?? "").join("\n");
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}
async function call(client, name, args = {}) {
  const text = await callText(client, name, args);
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

step("no token: 401");
const unauth = await fetch(MCP_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
});
assert.equal(unauth.status, 401);

step("read token: list/read tools only");
const reader = await connect(TOKEN_READ);
const readTools = (await reader.listTools()).tools.map((t) => t.name).sort();
console.log(`   ${readTools.join(", ")}`);
assert.ok(readTools.includes("paseo_wait_for_events"));
assert.ok(!readTools.includes("paseo_create_agent"));
await reader.close();

step("full token: all tools");
const client = await connect(TOKEN_FULL);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`   ${tools.length} tools: ${tools.join(", ")}`);
assert.equal(tools.length, 11);
console.log(`   server ${JSON.stringify(client.getServerVersion())}`);

const listed = await call(client, "paseo_list_agents", {});
let cursor = listed.events_cursor;
assert.ok(cursor, "events_cursor");

step(`create an agent on provider "${PROVIDER}" with origin_ref`);
const created = await call(client, "paseo_create_agent", {
  cwd: WORK_DIR,
  prompt: "hello from the smoke test",
  title: "smoke echo",
  provider: PROVIDER,
  labels: { origin_ref: "smoke-session-1" },
});
console.log(`   agent ${created.id}`);
const waited = await call(client, "paseo_wait_for_agent", { agent_id: created.id, timeout_sec: 60 });
console.log(`   wait: ${JSON.stringify(waited).slice(0, 300)}`);
assert.match(JSON.stringify(waited), /echo: hello from the smoke test/);

// Collects events until all wanted types arrived. Hook and push events may come in either order.
async function eventsUntil(types, label) {
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const r = await call(client, "paseo_wait_for_events", { cursor, timeout_sec: 10, agent_ids: [created.id] });
    cursor = r.next_cursor;
    seen.push(...r.events);
    if (types.every((t) => seen.some((e) => e.type === t))) {
      return { hit: seen.findLast((e) => e.type === types[0]), seen };
    }
  }
  throw new Error(`no ${label} event; saw ${seen.map((e) => e.type).join(", ")}`);
}
step("events: created, turn_started, turn_ended with labels");
const first = await eventsUntil(["agent.turn_ended", "agent.created"], "turn_ended");
console.log(`   ${first.seen.map((e) => `${e.type}${e.outcome ? `(${e.outcome})` : ""}[${e.source}]`).join(", ")}`);
assert.equal(first.hit.outcome, "finished");
assert.equal(first.hit.labels.origin_ref, "smoke-session-1");
assert.ok(first.hit.labels.origin, "origin label");

step("permission round trip");
await call(client, "paseo_send_message", { agent_id: created.id, text: "please ask permission" });
const perm = await eventsUntil(["agent.permission_requested"], "permission_requested");
const requestId = perm.hit.permission.requestId;
console.log(`   requested ${requestId}: ${perm.hit.summary}`);
const agent = await call(client, "paseo_get_agent", { agent_id: created.id });
assert.ok(JSON.stringify(agent).includes(requestId), "pending permission visible on the agent");
await call(client, "paseo_respond_permission", { agent_id: created.id, request_id: requestId, decision: "allow" });
const second = await eventsUntil(["agent.turn_ended", "agent.permission_resolved"], "second turn_ended");
console.log(`   ${second.seen.map((e) => `${e.type}[${e.source}]`).join(", ")}`);
const timeline = await callText(client, "paseo_read_timeline", { agent_id: created.id, limit: 20 });
assert.match(timeline, /permission: allow/);

step("archive");
await call(client, "paseo_archive_agent", { agent_id: created.id });
await eventsUntil(["agent.archived"], "archived");
await client.close();
console.log("HTTP CHECK OK");
