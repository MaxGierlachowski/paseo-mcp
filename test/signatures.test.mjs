// Unit tests for the webhook signature schemes, custom headers and the delivery body. Run after `npm run build`.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { EventHub } from "../dist/events.js";
import {
  WebhookDispatcher,
  checkCustomHeaders,
  checkSecret,
  deliveryBody,
  generateSecret,
  githubSignature,
  standardWebhooksKey,
  standardWebhooksSignature,
  verifyGithubSignature,
  verifySignature,
  verifyStandardWebhook,
} from "../dist/webhooks.js";
import { labelsFromMeta } from "../dist/tools.js";

let receiver;
let base;
const received = [];

before(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${receiver.address().port}`;
});

after(() => {
  receiver.closeAllConnections();
  receiver.close();
});

function dispatcher(endpoint, secret, headers) {
  received.length = 0;
  return new WebhookDispatcher({
    endpoints: () => [{ id: "w1", label: "T", url: `${base}/hook`, enabled: true, ...endpoint }],
    secret: () => secret,
    headers: () => headers,
    pauses: { isPaused: () => false, setPaused() {} },
    baseDelayMs: 5,
    maxAttempts: 1,
  });
}

const publish = (hub, extra = {}) => hub.publish({ type: "agent.turn_ended", agentId: "a", source: "hook", outcome: "finished", ...extra });

test("generated secrets are whsec_ + standard base64 that decodes to 24 bytes", () => {
  for (let i = 0; i < 50; i++) {
    const s = generateSecret();
    assert.match(s, /^whsec_[A-Za-z0-9+/]{32}$/);
    assert.equal(standardWebhooksKey(s).length, 24);
    assert.equal(checkSecret(s, "standard-webhooks"), null);
  }
});

test("checkSecret: imported secrets per scheme", () => {
  assert.equal(checkSecret("x".repeat(43), "standard-webhooks"), null, "raw secrets (e.g. token_urlsafe) are used as bytes");
  assert.match(checkSecret("whsec_abc-_def0123456789xyz", "standard-webhooks"), /standard base64/);
  assert.equal(checkSecret("whsec_abc-_def0123456789xyz", "paseo"), null, "paseo uses the string as is");
  assert.match(checkSecret("short"), /16/);
  assert.match(checkSecret("has a space in it......"), /whitespace/);
});

test("standard-webhooks: v1,<base64 HMAC(key, id.t.body)>, verifiable by an independent implementation", async () => {
  const secret = generateSecret();
  const d = dispatcher({ signature: "standard-webhooks" }, secret);
  d.handle(publish(new EventHub({ epoch: "e" })));
  await d.idle();
  const { headers, body } = received[0];
  assert.equal(headers["webhook-id"], "e:1");
  assert.match(headers["webhook-timestamp"], /^\d+$/);
  assert.equal(headers["paseo-mcp-signature"], undefined, "only the chosen scheme signs");
  // Reference: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`).digest("base64");
  assert.equal(headers["webhook-signature"], `v1,${expected}`);
  assert.ok(verifyStandardWebhook(secret, { id: headers["webhook-id"], timestamp: headers["webhook-timestamp"], signature: headers["webhook-signature"] }, body));
});

test("standard-webhooks: raw secrets, several signatures, tampering and old timestamps", () => {
  const raw = "Zb3mT0fM1jyKq3Yy2b1wK8n9p7c6x5v4u3t2s1r0q9o";
  const t = 1794150000;
  const sig = standardWebhooksSignature(raw, "id1", t, "{}");
  assert.equal(sig, `v1,${createHmac("sha256", Buffer.from(raw)).update(`id1.${t}.{}`).digest("base64")}`);
  const h = { id: "id1", timestamp: String(t), signature: `v1,AAAA ${sig}` };
  assert.ok(verifyStandardWebhook(raw, h, "{}", 300, t + 5), "any listed v1 signature may match");
  assert.ok(!verifyStandardWebhook(raw, h, "{ }", 300, t + 5));
  assert.ok(!verifyStandardWebhook(raw, { ...h, id: "id2" }, "{}", 300, t + 5));
  assert.ok(!verifyStandardWebhook(raw, h, "{}", 300, t + 400));
  assert.ok(!verifyStandardWebhook(raw, { ...h, signature: sig.replace("v1,", "v2,") }, "{}", 300, t + 5));
});

test("github: X-Hub-Signature-256 over the raw body, event and delivery headers", async () => {
  const secret = "gh-secret-0123456789";
  const d = dispatcher({ signature: "github" }, secret);
  d.handle(publish(new EventHub({ epoch: "e" })));
  await d.idle();
  const { headers, body } = received[0];
  assert.equal(headers["x-hub-signature-256"], `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  assert.equal(headers["x-hub-signature-256"], githubSignature(secret, body));
  assert.equal(headers["x-github-event"], "agent.turn_ended");
  assert.equal(headers["x-github-delivery"], "e:1");
  assert.ok(verifyGithubSignature(secret, headers["x-hub-signature-256"], body));
  assert.ok(!verifyGithubSignature("other-secret-000000", headers["x-hub-signature-256"], body));
  assert.ok(!verifyGithubSignature(secret, "sha1=abc", body));
});

test("paseo stays the default scheme", async () => {
  const secret = generateSecret();
  const d = dispatcher({}, secret);
  d.handle(publish(new EventHub({ epoch: "e" })));
  await d.idle();
  assert.ok(verifySignature(secret, received[0].headers["paseo-mcp-signature"], received[0].body));
  assert.equal(received[0].headers["webhook-signature"], undefined);
});

test("custom headers are sent; signing and transport headers cannot be replaced", async () => {
  const d = dispatcher({}, generateSecret(), { Authorization: "Bearer t0k3n", "X-Tenant": "a" });
  d.handle(publish(new EventHub({ epoch: "e" })));
  await d.idle();
  assert.equal(received[0].headers.authorization, "Bearer t0k3n");
  assert.equal(received[0].headers["x-tenant"], "a");
  assert.equal(received[0].headers["content-type"], "application/json");
  assert.equal(checkCustomHeaders({ Authorization: "Bearer x" }), null);
  assert.match(checkCustomHeaders({ "Content-Type": "text/plain" }), /cannot be replaced/);
  assert.match(checkCustomHeaders({ "webhook-signature": "v1,x" }), /cannot be replaced/);
  assert.match(checkCustomHeaders({ "paseo-mcp-signature": "x" }), /cannot be replaced/);
  assert.match(checkCustomHeaders({ "Bad Name": "x" }), /valid header name/);
  assert.match(checkCustomHeaders({ "X-A": "line\nbreak" }), /Invalid value/);
  assert.match(checkCustomHeaders({ "X-A": "1", "x-a": "2" }), /twice/);
});

test("a secret that does not fit the scheme fails the delivery with a readable error", async () => {
  const d = dispatcher({ signature: "standard-webhooks" }, "whsec_old-base64url_secret_value_");
  d.handle(publish(new EventHub({ epoch: "e" })));
  await d.idle();
  assert.equal(received.length, 0);
  const [rec] = d.status("w1").deliveries;
  assert.equal(rec.status, "failed");
  assert.match(rec.error, /standard-webhooks signature.*rotate/);
});

test("delivery body: source, version, type, summary and the newest event at top level", () => {
  const hub = new EventHub({ epoch: "e" });
  hub.publish({ type: "agent.created", agentId: "a", title: "fix login", labels: { origin: "hermes", origin_ref: "chat-1" }, cwd: "/repo", provider: "claude", source: "hook" });
  hub.publish({ type: "agent.turn_started", agentId: "a", source: "hook" });
  const ended = publish(hub, { outcome: "error", error: "boom" });
  const single = deliveryBody("e:3", "2026-11-18T00:00:00.000Z", [ended]);
  assert.equal(single.source, "paseo-mcp");
  assert.match(single.version, /^\d+\.\d+\.\d+$/);
  assert.equal(single.type, "agent.turn_ended");
  assert.equal(single.summary, 'Agent "fix login" failed: boom');
  assert.equal(single.event.labels.origin_ref, "chat-1");
  assert.equal(single.event.cwd, "/repo");
  assert.equal(single.event.provider, "claude");
  const batch = deliveryBody("e:1..3", "x", hub.since("e:0").events);
  assert.equal(batch.type, "batch");
  assert.equal(batch.event.seq, 3);
  assert.equal(batch.summary.split("\n").length, 3);
});

test("labelsFromMeta maps _meta fields (also dotted paths) onto labels", () => {
  const meta = { progressToken: 1, conversationId: "c-42", client: { session: "s-1" }, empty: "" };
  assert.deepEqual(labelsFromMeta(meta, { conversationId: "origin_ref", "client.session": "client_session", empty: "x", missing: "y" }), {
    origin_ref: "c-42",
    client_session: "s-1",
  });
  assert.deepEqual(labelsFromMeta(undefined, { a: "b" }), {});
  assert.equal(labelsFromMeta({ a: "x".repeat(500) }, { a: "b" }).b.length, 200);
});
