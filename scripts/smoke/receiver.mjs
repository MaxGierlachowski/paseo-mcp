#!/usr/bin/env node
// Webhook receiver for the Linux smoke test: verifies Standard Webhooks signatures with
// RECEIVER_SECRET and appends one JSON line per delivery to RECEIVER_LOG.
// Usage: RECEIVER_SECRET=whsec_… RECEIVER_LOG=/tmp/deliveries.jsonl node receiver.mjs <port>
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const secret = process.env.RECEIVER_SECRET ?? "";
const log = process.env.RECEIVER_LOG ?? "deliveries.jsonl";
const port = Number(process.argv[2] ?? 8799);

function verify(h, raw) {
  const id = h["webhook-id"];
  const t = h["webhook-timestamp"];
  if (!id || !t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
  const mac = createHmac("sha256", key).update(`${id}.${t}.${raw}`).digest();
  return (h["webhook-signature"] ?? "").split(" ").some((s) => {
    const given = Buffer.from(s.split(",")[1] ?? "", "base64");
    return given.length === mac.length && timingSafeEqual(given, mac);
  });
}

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const verified = verify(req.headers, raw);
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    const types = (body?.events ?? []).map((e) => e.type);
    appendFileSync(log, `${JSON.stringify({ verified, path: req.url, delivery: req.headers["paseo-mcp-delivery"], types, labels: body?.event?.labels ?? null, summary: body?.summary ?? null })}\n`);
    res.writeHead(verified ? 204 : 401).end();
  });
}).listen(port, "127.0.0.1", () => console.log(`receiver on 127.0.0.1:${port}`));
