// Unit tests for webhooks against a local receiver. Run after `npm run build`.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventHub } from "../dist/events.js";
import {
  WebhookDispatcher,
  checkWebhookUrl,
  generateSecret,
  sign,
  signatureHeader,
  verifySignature,
} from "../dist/webhooks.js";

const SECRET = generateSecret();
let receiver;
let base;
const received = [];
// Status codes the receiver answers with, one per request; 200 when empty.
const script = [];

before(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body, path: req.url });
      const status = script.shift() ?? 200;
      if (status === "hang") return; // never answers
      res.writeHead(status).end();
    });
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${receiver.address().port}`;
});

after(() => {
  receiver.closeAllConnections();
  receiver.close();
});

function setup(endpointOverrides = {}, opts = {}) {
  received.length = 0;
  script.length = 0;
  const paused = new Set();
  const endpoint = { id: "w1", label: "Test", url: `${base}/hook`, enabled: true, ...endpointOverrides };
  const logs = [];
  const d = new WebhookDispatcher({
    endpoints: () => [endpoint],
    secret: (id) => (id === "w1" ? SECRET : undefined),
    pauses: { isPaused: (id) => paused.has(id), setPaused: (id, p) => (p ? paused.add(id) : paused.delete(id)) },
    baseDelayMs: 10,
    timeoutMs: 300,
    log: (m) => logs.push(m),
    ...opts,
  });
  return { d, endpoint, paused, logs };
}

function event(hub, agentId = "a", type = "agent.created", extra = {}) {
  return hub.publish({ type, agentId, source: "hook", ...extra });
}

test("signature: HMAC-SHA256 over '<t>.<body>' and verification", () => {
  const body = '{"x":1}';
  const t = 1794150000;
  const header = signatureHeader("s3cret", t, body);
  assert.equal(header, `t=${t},v1=${sign("s3cret", t, body)}`);
  assert.match(sign("s3cret", t, body), /^[0-9a-f]{64}$/);
  assert.ok(verifySignature("s3cret", header, body, 300, t + 10));
  assert.ok(!verifySignature("other", header, body, 300, t + 10));
  assert.ok(!verifySignature("s3cret", header, body + " ", 300, t + 10));
  assert.ok(!verifySignature("s3cret", header, body, 300, t + 1000), "too old");
  assert.ok(!verifySignature("s3cret", null, body));
  assert.ok(!verifySignature("s3cret", "t=x,v1=zz", body));
});

test("URL policy: https anywhere, http only local or private", () => {
  assert.equal(checkWebhookUrl("https://example.com/hook"), null);
  assert.equal(checkWebhookUrl("http://127.0.0.1:8080/x"), null);
  assert.equal(checkWebhookUrl("http://localhost:9/x"), null);
  assert.equal(checkWebhookUrl("http://192.168.1.5/x"), null);
  assert.equal(checkWebhookUrl("http://10.0.0.2/x"), null);
  assert.equal(checkWebhookUrl("http://[::1]:9/x"), null);
  assert.match(checkWebhookUrl("http://example.com/x"), /https/);
  assert.match(checkWebhookUrl("http://8.8.8.8/x"), /https/);
  assert.match(checkWebhookUrl("ftp://example.com"), /Only/);
  assert.match(checkWebhookUrl("https://user:pw@example.com"), /credentials/);
  assert.match(checkWebhookUrl("nope"), /valid/);
});

test("delivers a signed event with delivery and event id headers", async () => {
  const { d } = setup();
  const hub = new EventHub({ epoch: "e" });
  d.handle(event(hub));
  await d.idle();
  assert.equal(received.length, 1);
  const r = received[0];
  const body = JSON.parse(r.body);
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].type, "agent.created");
  assert.equal(body.delivery_id, "e:1");
  assert.equal(r.headers["paseo-mcp-delivery"], "e:1");
  assert.equal(r.headers["paseo-mcp-event-id"], "e:1");
  assert.ok(verifySignature(SECRET, r.headers["paseo-mcp-signature"], r.body));
  const st = d.status("w1");
  assert.equal(st.deliveries[0].status, "delivered");
  assert.equal(st.deliveries[0].httpStatus, 200);
});

test("filters: types, labels, only needs attention", async () => {
  const { d } = setup({ types: ["agent.turn_ended"], labels: { origin: "hermes" } });
  const hub = new EventHub({ epoch: "e" });
  d.handle(event(hub, "a", "agent.created", { labels: { origin: "hermes" } }));
  d.handle(event(hub, "a", "agent.turn_started"));
  d.handle(event(hub, "a", "agent.turn_ended", { outcome: "finished" }));
  d.handle(event(hub, "b", "agent.created", { labels: { origin: "x" } }));
  d.handle(event(hub, "b", "agent.turn_started"));
  d.handle(event(hub, "b", "agent.turn_ended", { outcome: "finished" }));
  await d.idle();
  assert.deepEqual(received.map((r) => JSON.parse(r.body).events[0].agentId), ["a"]);
});

test("retries 5xx with backoff, same delivery id, then succeeds", async () => {
  const { d } = setup();
  script.push(500, 503);
  const hub = new EventHub({ epoch: "e" });
  const t = Date.now();
  d.handle(event(hub));
  await d.idle();
  assert.equal(received.length, 3);
  assert.equal(new Set(received.map((r) => r.headers["paseo-mcp-delivery"])).size, 1);
  assert.ok(Date.now() - t >= 25, "waited 10 + 20 ms");
  const [rec] = d.status("w1").deliveries;
  assert.equal(rec.status, "delivered");
  assert.equal(rec.attempts, 3);
});

test("4xx (other than 408/429) is not retried", async () => {
  const { d } = setup();
  script.push(400);
  d.handle(event(new EventHub({ epoch: "e" })));
  await d.idle();
  assert.equal(received.length, 1);
  assert.equal(d.status("w1").deliveries[0].status, "failed");
  assert.equal(d.status("w1").deliveries[0].error, "HTTP 400");
});

test("timeouts count as failures and are retried", async () => {
  const { d } = setup({}, { maxAttempts: 2 });
  script.push("hang", "hang");
  d.handle(event(new EventHub({ epoch: "e" })));
  await d.idle();
  const [rec] = d.status("w1").deliveries;
  assert.equal(rec.status, "failed");
  assert.equal(rec.attempts, 2);
  assert.equal(rec.error, "Timed out");
});

test("pauses after repeated failed deliveries, drops while paused, resumes", async () => {
  const { d, paused, logs } = setup({}, { maxAttempts: 1, pauseAfter: 3 });
  const hub = new EventHub({ epoch: "e" });
  script.push(500, 500, 500);
  for (const id of ["a", "b", "c"]) {
    d.handle(event(hub, id));
    await d.idle();
  }
  assert.ok(paused.has("w1"));
  assert.match(logs[0], /paused after 3/);
  d.handle(event(hub, "d"));
  await d.idle();
  assert.equal(received.length, 3, "nothing sent while paused");
  assert.equal(d.status("w1").dropped, 1);
  d.resume("w1");
  assert.equal(paused.has("w1"), false);
  d.handle(event(hub, "e"));
  await d.idle();
  assert.equal(received.length, 4);
  assert.equal(d.status("w1").consecutiveFailures, 0);
});

test("batching: events within batchMs go out in one delivery", async () => {
  const { d } = setup({ batchMs: 50 });
  const hub = new EventHub({ epoch: "e" });
  d.handle(event(hub, "a"));
  d.handle(event(hub, "b"));
  d.handle(event(hub, "c"));
  await new Promise((r) => setTimeout(r, 120));
  await d.idle();
  assert.equal(received.length, 1);
  const body = JSON.parse(received[0].body);
  assert.deepEqual(body.events.map((e) => e.agentId), ["a", "b", "c"]);
  assert.equal(body.delivery_id, "e:1..3");
});

test("test event ignores filters and pause and is not retried", async () => {
  const { d, paused } = setup({ types: ["agent.closed"] });
  paused.add("w1");
  script.push(500);
  const rec = await d.test("w1");
  assert.equal(rec.test, true);
  assert.equal(rec.attempts, 1);
  assert.equal(rec.status, "failed");
  const ok = await d.test("w1");
  assert.equal(ok.status, "delivered");
  assert.equal(JSON.parse(received[1].body).events[0].type, "webhook.test");
  assert.equal(d.status("w1").consecutiveFailures, 0, "tests do not count towards pausing");
});

test("disabled endpoints and missing secrets", async () => {
  const { d, endpoint } = setup({ enabled: false });
  d.handle(event(new EventHub({ epoch: "e" })));
  await d.idle();
  assert.equal(received.length, 0);
  endpoint.enabled = true;
  endpoint.id = "w2"; // no secret
  d.handle(event(new EventHub({ epoch: "e" })));
  await d.idle();
  assert.equal(d.status("w2").deliveries[0].status, "failed");
  assert.match(d.status("w2").deliveries[0].error, /secret/);
});

test("stop ends deliveries waiting for a retry", async () => {
  const { d } = setup({}, { baseDelayMs: 60_000 });
  script.push(500);
  d.handle(event(new EventHub({ epoch: "e" })));
  await new Promise((r) => setTimeout(r, 50));
  const t = Date.now();
  d.stop();
  await d.idle();
  assert.ok(Date.now() - t < 1000);
});
