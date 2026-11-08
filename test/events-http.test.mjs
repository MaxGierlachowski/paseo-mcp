// Integration test: events over the real HTTP server with MCP clients. Run after `npm run build`.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceUpdatedNotificationSchema, ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { newToken } from "../dist/auth.js";
import { EventHub } from "../dist/events.js";
import { startHttpServer } from "../dist/http.js";
import { registerTools } from "../dist/tools.js";
import { registerAgentResources } from "../dist/resources.js";

const config = { allowedRoots: [], accounts: {}, accountEnvVar: "CLAUDE_CONFIG_DIR", originLabel: "t", readOnly: false };
const agent = (id, labels = {}) => ({
  id, title: `Agent ${id}`, status: "idle", requiresAttention: false, provider: "claude", model: "x", cwd: "/tmp",
  labels, pendingPermissions: [], updatedAt: "2026-11-08T10:00:00Z", lastUserMessageAt: null,
});
const agents = [agent("a1", { origin: "hermes" }), agent("b2", { origin: "other" })];
const paseo = {
  agents: {
    async list({ filter } = {}) {
      const want = filter?.labels ?? {};
      const entries = agents.filter((a) => Object.entries(want).every(([k, v]) => a.labels[k] === v)).map((a) => ({ agent: a }));
      return { entries, pageInfo: { nextCursor: null } };
    },
    ref(id) {
      const a = agents.find((x) => x.id === id);
      return { id, refresh: async () => (a ? { agent: a } : null), current: () => a };
    },
  },
};

const hub = new EventHub({ epoch: "test" });
const reader = newToken({ label: "reader", scope: "read" });
const hermesOnly = newToken({ label: "hermes-only", scope: "read" });
const filters = { [hermesOnly.record.id]: { labels: { origin: "hermes" } } };
let server;

before(async () => {
  server = await startHttpServer({
    bind: "127.0.0.1",
    port: 0,
    tokens: () => [reader.record, hermesOnly.record],
    createMcpServer: (token) => {
      const s = new McpServer({ name: "paseo", version: "test" });
      const eventFilter = () => filters[token.id];
      registerAgentResources(s, { events: hub, paseo: async () => paseo, eventFilter });
      registerTools(s, { config: () => config, paseo: async () => paseo, scope: token.scope, events: hub, eventFilter });
      return s;
    },
  });
});

after(async () => {
  await server?.close();
});

async function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const json = (r) => JSON.parse(r.content[0].text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("read token sees paseo_wait_for_events and declares resource subscriptions", async () => {
  const c = await connect(reader.token);
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("paseo_wait_for_events"));
  assert.equal(names.length, 6);
  const caps = c.getServerCapabilities();
  assert.equal(caps.resources.subscribe, true);
  assert.equal(caps.resources.listChanged, true);
  const desc = (await c.listTools()).tools.find((t) => t.name === "paseo_wait_for_events").description;
  assert.match(desc, /next_cursor/);
  await c.close();
});

test("paseo_list_agents and the agents resource carry the events cursor", async () => {
  const c = await connect(reader.token);
  const list = json(await c.callTool({ name: "paseo_list_agents", arguments: {} }));
  assert.equal(list.events_cursor, hub.cursor());
  const res = await c.readResource({ uri: "paseo://agents" });
  const body = JSON.parse(res.contents[0].text);
  assert.equal(body.events_cursor, hub.cursor());
  assert.equal(body.count, 2);
  const one = JSON.parse((await c.readResource({ uri: "paseo://agents/a1" })).contents[0].text);
  assert.equal(one.id, "a1");
  await c.close();
});

test("wait_for_events returns when a hook event arrives", async () => {
  const c = await connect(reader.token);
  const { next_cursor: cursor } = json(await c.callTool({ name: "paseo_wait_for_events", arguments: { timeout_sec: 0 } }));
  setTimeout(() => hub.publish({ type: "agent.created", agentId: "a1", source: "hook", labels: { origin: "hermes" }, title: "Agent a1" }), 100);
  const t = Date.now();
  const r = json(await c.callTool({ name: "paseo_wait_for_events", arguments: { cursor, timeout_sec: 10 } }));
  assert.ok(Date.now() - t >= 90 && Date.now() - t < 5000);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, "agent.created");
  assert.equal(r.gap, false);
  assert.equal(r.next_cursor, hub.cursor());
  // Immediately again with the new cursor: nothing pending, returns at once with timeout 0.
  const again = json(await c.callTool({ name: "paseo_wait_for_events", arguments: { cursor: r.next_cursor, timeout_sec: 0 } }));
  assert.equal(again.events.length, 0);
  // A cursor from a previous server run: gap with the current state.
  const gap = json(await c.callTool({ name: "paseo_wait_for_events", arguments: { cursor: "oldrun:7", timeout_sec: 0 } }));
  assert.equal(gap.gap, true);
  assert.ok(gap.agents.some((s) => s.agentId === "a1"));
  await c.close();
});

test("a token's label filter applies to events", async () => {
  const c = await connect(hermesOnly.token);
  const cursor = hub.cursor();
  hub.publish({ type: "agent.created", agentId: "b2", source: "hook", labels: { origin: "other" } });
  hub.publish({ type: "agent.turn_started", agentId: "a1", source: "hook" });
  // Even asking for b2 explicitly does not widen the token's filter.
  const r = json(await c.callTool({ name: "paseo_wait_for_events", arguments: { cursor, timeout_sec: 0 } }));
  assert.deepEqual(r.events.map((e) => e.agentId), ["a1"]);
  const res = JSON.parse((await c.readResource({ uri: "paseo://agents" })).contents[0].text);
  assert.deepEqual(res.agents.map((a) => a.id), ["a1"]);
  await c.close();
});

test("closing the session ends a pending wait", async () => {
  const c = await connect(reader.token);
  const before = hub.listenerCount();
  const pending = c.callTool({ name: "paseo_wait_for_events", arguments: { timeout_sec: 200 } }).catch((e) => e);
  await sleep(150);
  assert.equal(hub.listenerCount(), before + 1);
  await server.closeSessions(() => true);
  await sleep(100);
  // closeSessions closed every open session: the waiter and all resource listeners are gone.
  assert.equal(hub.listenerCount(), 0, "the waiter is gone");
  await c.close().catch(() => {});
  await pending;
});

test("subscribed sessions get resources/updated and list_changed; others get nothing", async () => {
  const sub = await connect(reader.token);
  const quiet = await connect(reader.token);
  const updates = [];
  const listChanges = [];
  const quietSeen = [];
  sub.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => updates.push(n.params.uri));
  sub.setNotificationHandler(ResourceListChangedNotificationSchema, () => listChanges.push(1));
  quiet.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => quietSeen.push(n.params.uri));
  quiet.setNotificationHandler(ResourceListChangedNotificationSchema, () => quietSeen.push("list"));
  await sub.subscribeResource({ uri: "paseo://agents" });
  await sub.subscribeResource({ uri: "paseo://agents/a1" });
  await sleep(200); // the GET stream is open

  hub.publish({ type: "agent.turn_ended", agentId: "a1", source: "hook", outcome: "finished" });
  hub.publish({ type: "agent.created", agentId: "c3", source: "hook" });
  await sleep(300);
  assert.deepEqual(updates, ["paseo://agents", "paseo://agents/a1", "paseo://agents"]);
  assert.equal(listChanges.length, 1);
  assert.deepEqual(quietSeen, []);

  await sub.unsubscribeResource({ uri: "paseo://agents" });
  await sub.unsubscribeResource({ uri: "paseo://agents/a1" });
  hub.publish({ type: "agent.archived", agentId: "c3", source: "hook" });
  await sleep(200);
  assert.equal(updates.length, 3, "nothing after unsubscribing");
  await sub.close();
  await quiet.close();
});

// ---------------------------------------------------------------- SSE resume

async function rawSession() {
  const post = (body, sid) =>
    fetch(server.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${reader.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sid ? { "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" } : {}),
      },
      body: JSON.stringify(body),
    });
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
  const sid = init.headers.get("mcp-session-id");
  await init.text();
  await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid)).text();
  await (await post({ jsonrpc: "2.0", id: 2, method: "resources/subscribe", params: { uri: "paseo://agents" } }, sid)).text();
  return sid;
}

/** Opens the GET stream and collects SSE events until `count` arrived or the time is up. */
async function readStream(sid, { lastEventId, count, ms = 1500 } = {}) {
  const ac = new AbortController();
  const res = await fetch(server.url, {
    headers: {
      authorization: `Bearer ${reader.token}`,
      accept: "text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-06-18",
      ...(lastEventId ? { "last-event-id": lastEventId } : {}),
    },
    signal: ac.signal,
  });
  assert.equal(res.status, 200);
  const events = [];
  const timer = setTimeout(() => ac.abort(), ms);
  const reader_ = res.body.getReader();
  let buf = "";
  try {
    while (events.length < count) {
      const { value, done } = await reader_.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const id = /^id: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data) events.push({ id, message: JSON.parse(data) });
      }
    }
  } catch {
    // aborted
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return events;
}

test("SSE resume: a client reconnecting with Last-Event-ID receives what it missed", async () => {
  const sid = await rawSession();
  const firstRead = readStream(sid, { count: 1 });
  await sleep(150);
  hub.publish({ type: "agent.turn_started", agentId: "a1", source: "hook" });
  const first = await firstRead;
  assert.equal(first.length, 1);
  assert.equal(first[0].message.method, "notifications/resources/updated");
  assert.ok(first[0].id, "SSE events carry ids");

  // Stream is gone; two more events happen meanwhile.
  await sleep(100);
  hub.publish({ type: "agent.turn_ended", agentId: "a1", source: "hook", outcome: "finished" });
  hub.publish({ type: "agent.created", agentId: "d4", source: "hook" });
  await sleep(100);

  const replay = await readStream(sid, { lastEventId: first[0].id, count: 3, ms: 1000 });
  const methods = replay.map((e) => e.message.method);
  assert.ok(methods.length >= 2, `replayed: ${methods.join(", ")}`);
  assert.equal(methods[0], "notifications/resources/updated");
  assert.ok(methods.includes("notifications/resources/list_changed"));
  assert.ok(!replay.some((e) => e.id === first[0].id), "already seen events are not repeated");
});
