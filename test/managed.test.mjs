// Managed settings file and the paseo-mcp-admin CLI. Run after `npm run build`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashToken } from "../dist/auth.js";
import { loadManaged, managedPath, mergeManaged, resolveManaged } from "../dist/managed.js";

const ADMIN = fileURLToPath(new URL("../dist/admin.js", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "paseo-mcp-managed-"));

const ui = {
  http: { enabled: false, port: 6790, bind: "127.0.0.1" },
  tokens: [{ id: "u1", label: "Screen", scope: "read", hash: "a".repeat(64), createdAt: "2026-01-01T00:00:00Z" }],
  webhooks: [],
  allowedRoots: ["/srv/ui"],
  accounts: {},
  accountEnvVar: "CLAUDE_CONFIG_DIR",
  metaLabels: {},
  readOnly: false,
  events: { previewChars: 0 },
};

test("managedPath: $PASEO_MCP_MANAGED, else $PASEO_HOME/paseo-mcp.managed.json", () => {
  const prev = { m: process.env.PASEO_MCP_MANAGED, h: process.env.PASEO_HOME };
  try {
    delete process.env.PASEO_MCP_MANAGED;
    process.env.PASEO_HOME = "/var/lib/paseo";
    assert.equal(managedPath(), "/var/lib/paseo/paseo-mcp.managed.json");
    process.env.PASEO_MCP_MANAGED = "/etc/paseo-mcp/managed.json";
    assert.equal(managedPath(), "/etc/paseo-mcp/managed.json");
  } finally {
    for (const [k, v] of [["PASEO_MCP_MANAGED", prev.m], ["PASEO_HOME", prev.h]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("resolveManaged: tokens by hash or plain token, webhooks with secrets split off", () => {
  const m = resolveManaged({
    http: { enabled: true },
    tokens: [
      { label: "hermes-ui", scope: "full", token: "pmcp_0123456789abcdefghijklmnop" },
      { id: "watch", label: "Watcher", scope: "read", hash: "b".repeat(64), labelFilter: { origin: "hermes" } },
    ],
    webhooks: [
      { label: "bridge", url: "http://127.0.0.1:8644/webhooks/paseo", signature: "standard-webhooks", secret: "whsec_dGVzdHNlY3JldHRlc3RzZWNyZXQ=", headers: { "X-Route": "a" } },
    ],
  });
  assert.equal(m.tokens[0].id, "managed:hermes-ui");
  assert.equal(m.tokens[0].hash, hashToken("pmcp_0123456789abcdefghijklmnop"));
  assert.ok(!JSON.stringify(m.tokens).includes("pmcp_0123"));
  assert.deepEqual(m.tokens[1].labelFilter, { origin: "hermes" });
  assert.equal(m.webhooks[0].id, "managed:bridge");
  assert.equal(m.webhooks[0].types.length, 0);
  assert.equal(m.webhooks[0].secretHint, "ZXQ=");
  assert.ok(!JSON.stringify(m.webhooks).includes("whsec_"));
  assert.equal(m.secrets.get("managed:bridge"), "whsec_dGVzdHNlY3JldHRlc3RzZWNyZXQ=");
  assert.deepEqual(m.headers.get("managed:bridge"), { "X-Route": "a" });
});

test("resolveManaged rejects bad files with a readable reason", () => {
  assert.throws(() => resolveManaged({ tokens: [{ label: "x", scope: "full" }] }), /exactly one of hash or token/);
  assert.throws(() => resolveManaged({ tokens: [{ label: "x", scope: "admin", hash: "c".repeat(64) }] }), /tokens\.0\.scope/);
  assert.throws(() => resolveManaged({ unknownKey: 1 }), /unknownKey|Unrecognized/);
  assert.throws(
    () => resolveManaged({ tokens: [{ label: "a", scope: "read", hash: "c".repeat(64) }, { label: "a", scope: "full", hash: "d".repeat(64) }] }),
    /two tokens with the id "a"/,
  );
  // Tokens and webhooks have separate id spaces.
  assert.doesNotThrow(() =>
    resolveManaged({
      tokens: [{ label: "bridge", scope: "read", hash: "c".repeat(64) }],
      webhooks: [{ label: "bridge", url: "http://127.0.0.1:8644/x", secret: "whsec_dGVzdHNlY3JldHRlc3RzZWNyZXQ=" }],
    }),
  );
  assert.throws(() => resolveManaged({ webhooks: [{ label: "w", url: "http://example.com/x", secret: "s" }] }), /webhook "w"/);
  assert.throws(() => resolveManaged({ accounts: { a: { configDir: "/x" } }, defaultAccount: "b" }), /defaultAccount/);
});

test("mergeManaged: file values win, tokens and webhooks are added", () => {
  const m = resolveManaged({
    http: { enabled: true, port: 6800 },
    allowedRoots: ["/srv/work"],
    originLabel: "hermes",
    readOnly: false,
    events: { previewChars: 200 },
    tokens: [{ label: "hermes-ui", scope: "full", hash: "e".repeat(64) }],
  });
  const s = mergeManaged(ui, m);
  assert.deepEqual(s.http, { enabled: true, port: 6800, bind: "127.0.0.1" });
  assert.deepEqual(s.allowedRoots, ["/srv/work"]);
  assert.equal(s.originLabel, "hermes");
  assert.equal(s.events.previewChars, 200);
  assert.deepEqual(s.tokens.map((t) => t.id), ["u1", "managed:hermes-ui"]);
  assert.equal(mergeManaged(ui, null), ui);
  // Keys the file leaves out keep the screen's values.
  const only = mergeManaged(ui, resolveManaged({ tokens: [] }));
  assert.deepEqual(only.allowedRoots, ["/srv/ui"]);
  assert.equal(only.http.enabled, false);
});

test("loadManaged: missing, empty, invalid JSON, ready", () => {
  const dir = tmp();
  const file = join(dir, "m.json");
  assert.equal(loadManaged(file).status, "missing");
  writeFileSync(file, "  \n");
  assert.equal(loadManaged(file).status, "missing");
  writeFileSync(file, "{nope");
  const bad = loadManaged(file);
  assert.equal(bad.status, "invalid");
  assert.match(bad.error, /m\.json/);
  writeFileSync(file, JSON.stringify({ http: { enabled: true } }));
  assert.equal(loadManaged(file).status, "ready");
});

const admin = (file, ...args) => spawnSync(process.execPath, [ADMIN, "--file", file, ...args], { encoding: "utf8" });

test("admin: token create prints the token once and stores only its hash (mode 600)", () => {
  const file = join(tmp(), "sub", "managed.json");
  const r = admin(file, "token", "create", "--label", "hermes-ui", "--scope", "full", "--origin", "hermes");
  assert.equal(r.status, 0, r.stderr);
  const token = r.stdout.trim();
  assert.match(token, /^pmcp_[A-Za-z0-9_-]{43}$/);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(token));
  const doc = JSON.parse(text);
  assert.equal(doc.tokens[0].hash, hashToken(token));
  assert.equal(doc.tokens[0].origin, "hermes");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // The same id again needs --replace, which rotates it.
  assert.equal(admin(file, "token", "create", "--label", "hermes-ui", "--scope", "full").status, 1);
  const again = admin(file, "token", "create", "--label", "hermes-ui", "--scope", "read", "--replace");
  assert.equal(again.status, 0, again.stderr);
  const rotated = JSON.parse(readFileSync(file, "utf8")).tokens;
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0].scope, "read");
  assert.equal(rotated[0].hash, hashToken(again.stdout.trim()));
});

test("admin: --out writes the token to a file, list and revoke, other keys survive", () => {
  const dir = tmp();
  const file = join(dir, "managed.json");
  writeFileSync(file, JSON.stringify({ http: { enabled: true }, allowedRoots: ["/srv/work"] }));
  const out = join(dir, "token");
  const r = admin(file, "token", "create", "--id", "bridge", "--label", "Bridge", "--scope", "read", "--label-filter", "origin=hermes", "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const token = readFileSync(out, "utf8").trim();
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.allowedRoots, ["/srv/work"]);
  assert.equal(doc.tokens[0].id, "bridge");
  assert.equal(doc.tokens[0].hash, hashToken(token));
  assert.deepEqual(doc.tokens[0].labelFilter, { origin: "hermes" });
  const list = JSON.parse(admin(file, "token", "list", "--json").stdout);
  assert.deepEqual(list.map((t) => [t.id, t.scope]), [["bridge", "read"]]);
  assert.ok(!JSON.stringify(list).includes(doc.tokens[0].hash));
  assert.equal(admin(file, "token", "revoke", "bridge").status, 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).tokens.length, 0);
  assert.equal(admin(file, "token", "revoke", "bridge").status, 1);
});

test("admin: hash, check, path and usage errors", () => {
  const dir = tmp();
  const file = join(dir, "managed.json");
  assert.equal(execFileSync(process.execPath, [ADMIN, "hash"], { input: "abc\n", encoding: "utf8" }).trim(), hashToken("abc"));
  assert.equal(admin(file, "path").stdout.trim(), file);
  assert.equal(admin(file, "check").status, 0);
  writeFileSync(file, JSON.stringify({ tokens: [{ label: "x", scope: "full" }] }));
  const bad = admin(file, "check");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /exactly one of hash or token/);
  assert.equal(admin(file, "token", "create", "--label", "y").status, 2);
  assert.equal(admin(file, "frobnicate").status, 2);
});
