/**
 * Access control for the HTTP transport: bearer tokens stored only as SHA-256 hashes, and the
 * Host/Origin checks the MCP spec asks local HTTP servers to make against DNS rebinding.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { Scope } from "./tools.js";

export interface TokenRecord {
  id: string;
  label: string;
  scope: Scope;
  /** Hex SHA-256 of the token. The token itself is never stored. */
  hash: string;
  createdAt: string;
  /** `origin` label on agents this token creates; defaults to the label. */
  origin?: string;
}

const TOKEN_PREFIX = "pmcp_";

/** 32 random bytes, base64url, with a prefix so leaked tokens are easy to recognise. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new token and the record to store for it. The token is returned once and kept nowhere. */
export function newToken(input: { label: string; scope: Scope; origin?: string }, now = new Date()) {
  const token = generateToken();
  const record: TokenRecord = {
    id: randomUUID(),
    label: input.label,
    scope: input.scope,
    hash: hashToken(token),
    createdAt: now.toISOString(),
    ...(input.origin ? { origin: input.origin } : {}),
  };
  return { token, record };
}

/** The token from an `Authorization: Bearer …` header, or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Finds the record whose hash matches the token. Compares against every record in constant time
 * per comparison and does not stop at the first match, so timing says nothing about the store.
 */
export function findToken<T extends Pick<TokenRecord, "hash">>(
  token: string | null,
  records: readonly T[],
): T | null {
  if (!token) return null;
  const presented = Buffer.from(hashToken(token), "hex");
  let found: T | null = null;
  for (const record of records) {
    const stored = Buffer.from(record.hash, "hex");
    if (stored.length === presented.length && timingSafeEqual(stored, presented) && !found) {
      found = record;
    }
  }
  return found;
}

// ---------------------------------------------------------------- Host / Origin

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

export function isLoopback(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost" || bind.startsWith("127.");
}

function hostPart(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

/**
 * Host header values (`name:port`, lower case) the server answers to. Loopback binds accept only
 * loopback names. Other binds also accept the bind address, or for a wildcard bind every local
 * interface address and the machine's host name.
 */
export function allowedHosts(bind: string, port: number): Set<string> {
  const names = new Set(LOOPBACK_NAMES);
  if (!isLoopback(bind)) {
    if (bind === "0.0.0.0" || bind === "::") {
      for (const list of Object.values(networkInterfaces())) {
        for (const iface of list ?? []) names.add(hostPart(iface.address.split("%")[0]));
      }
      const host = hostname().toLowerCase();
      names.add(host);
      if (!host.endsWith(".local")) names.add(`${host}.local`);
    } else {
      names.add(hostPart(bind));
    }
  }
  return new Set([...names].map((n) => `${n.toLowerCase()}:${port}`));
}

/** Rejects requests whose Host header is not one of ours (DNS rebinding). */
export function checkHost(header: string | undefined, allowed: ReadonlySet<string>): boolean {
  return typeof header === "string" && allowed.has(header.trim().toLowerCase());
}

/**
 * Browsers send Origin; MCP clients outside a browser usually don't. An Origin, when present,
 * must point at this server itself. "null" and anything unparsable are refused.
 */
export function checkOrigin(header: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (header === undefined) return true;
  let url: URL;
  try {
    url = new URL(header);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return allowed.has(`${url.hostname.toLowerCase()}:${port}`);
}
