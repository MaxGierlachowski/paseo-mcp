// Unit tests for tokens, hashing, Host/Origin checks. Run after `npm run build`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedHosts,
  bearerToken,
  checkHost,
  checkOrigin,
  findToken,
  generateToken,
  hashToken,
  isLoopback,
  newToken,
} from "../dist/auth.js";
import { READ_TOOLS, WRITE_TOOLS } from "../dist/tools.js";

test("tokens are random, prefixed and long", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.match(a, /^pmcp_[A-Za-z0-9_-]{43}$/);
});

test("hashToken is hex SHA-256", () => {
  assert.equal(
    hashToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("newToken stores only the hash", () => {
  const { token, record } = newToken({ label: "Hermes", scope: "read" }, new Date("2026-11-08T10:00:00Z"));
  assert.equal(record.hash, hashToken(token));
  assert.equal(record.createdAt, "2026-11-08T10:00:00.000Z");
  assert.equal(record.scope, "read");
  assert.ok(!JSON.stringify(record).includes(token));
  assert.equal("origin" in record, false);
  assert.equal(newToken({ label: "x", scope: "full", origin: "hermes" }).record.origin, "hermes");
});

test("bearerToken parses the Authorization header", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer abc"), "abc");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken("Bearer"), null);
  assert.equal(bearerToken("Bearer a b"), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(["Bearer abc"]), null);
});

test("findToken matches by hash and rejects everything else", () => {
  const a = newToken({ label: "a", scope: "read" });
  const b = newToken({ label: "b", scope: "full" });
  const records = [a.record, b.record];
  assert.equal(findToken(a.token, records)?.id, a.record.id);
  assert.equal(findToken(b.token, records)?.scope, "full");
  assert.equal(findToken(a.token + "x", records), null);
  assert.equal(findToken(null, records), null);
  assert.equal(findToken("", records), null);
  // The hash itself is not a valid token.
  assert.equal(findToken(a.record.hash, records), null);
  // A malformed stored hash never matches.
  assert.equal(findToken(a.token, [{ ...a.record, hash: "zz" }]), null);
});

test("revoking a token is removing its record", () => {
  const a = newToken({ label: "a", scope: "full" });
  const remaining = [a.record].filter((r) => r.id !== a.record.id);
  assert.equal(findToken(a.token, remaining), null);
});

test("scopes: read has the five read tools, full adds five more", () => {
  assert.deepEqual([...READ_TOOLS], [
    "paseo_list_agents",
    "paseo_get_agent",
    "paseo_read_timeline",
    "paseo_list_accounts",
    "paseo_list_models",
  ]);
  assert.equal(WRITE_TOOLS.length, 5);
  assert.ok(WRITE_TOOLS.every((t) => !READ_TOOLS.includes(t)));
});

test("loopback binds accept only loopback host names", () => {
  const hosts = allowedHosts("127.0.0.1", 6790);
  assert.ok(checkHost("127.0.0.1:6790", hosts));
  assert.ok(checkHost("localhost:6790", hosts));
  assert.ok(checkHost("LOCALHOST:6790", hosts));
  assert.ok(checkHost("[::1]:6790", hosts));
  assert.ok(!checkHost("localhost:6791", hosts));
  assert.ok(!checkHost("evil.example:6790", hosts));
  assert.ok(!checkHost("localhost", hosts));
  assert.ok(!checkHost(undefined, hosts));
});

test("a specific non-loopback bind also accepts its own address", () => {
  const hosts = allowedHosts("192.168.1.20", 6790);
  assert.ok(checkHost("192.168.1.20:6790", hosts));
  assert.ok(checkHost("127.0.0.1:6790", hosts));
  assert.ok(!checkHost("192.168.1.21:6790", hosts));
});

test("isLoopback", () => {
  assert.ok(isLoopback("127.0.0.1"));
  assert.ok(isLoopback("::1"));
  assert.ok(isLoopback("localhost"));
  assert.ok(!isLoopback("0.0.0.0"));
  assert.ok(!isLoopback("192.168.1.20"));
});

test("Origin: absent is fine, foreign or null is refused", () => {
  const hosts = allowedHosts("127.0.0.1", 6790);
  assert.ok(checkOrigin(undefined, hosts));
  assert.ok(checkOrigin("http://127.0.0.1:6790", hosts));
  assert.ok(checkOrigin("http://localhost:6790", hosts));
  assert.ok(checkOrigin("http://[::1]:6790", hosts));
  assert.ok(!checkOrigin("http://evil.example", hosts));
  assert.ok(!checkOrigin("http://evil.example:6790", hosts));
  assert.ok(!checkOrigin("http://localhost:3000", hosts));
  assert.ok(!checkOrigin("null", hosts));
  assert.ok(!checkOrigin("file://", hosts));
  assert.ok(!checkOrigin("", hosts));
});
