/**
 * Webhooks (plugin mode): POSTs agent events to configured endpoints.
 *
 * Body: {"delivery_id", "sent_at", "source", "version", "type", "summary", "event", "events": [AgentEvent, ...]}.
 * `event` is the newest event of the delivery, so templates that cannot index arrays reach it.
 * Each endpoint picks how deliveries are signed (`signature`):
 *   paseo (default)    Paseo-Mcp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *   standard-webhooks  webhook-id, webhook-timestamp, webhook-signature: v1,<base64 HMAC-SHA256(key, "<id>.<t>.<raw body>")>
 *                      (standardwebhooks.com; key = base64-decoded secret after "whsec_", else the secret's bytes)
 *   github             X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>, X-GitHub-Event, X-GitHub-Delivery
 * Always: Paseo-Mcp-Delivery (delivery id, the same on every retry: use it for idempotency) and
 * Paseo-Mcp-Event-Id (id of the first event), plus the endpoint's static custom headers.
 * Retries with exponential backoff on network errors, timeouts, 408, 429 and 5xx. After
 * `pauseAfter` failed deliveries in a row the endpoint pauses until resumed.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { matches, type AgentEvent, type EventType } from "./events.js";
import { VERSION } from "./version.js";

export const SIGNATURE_HEADER = "Paseo-Mcp-Signature";
export const DELIVERY_HEADER = "Paseo-Mcp-Delivery";
export const EVENT_ID_HEADER = "Paseo-Mcp-Event-Id";

export const SIGNATURE_SCHEMES = ["paseo", "standard-webhooks", "github"] as const;
export type SignatureScheme = (typeof SIGNATURE_SCHEMES)[number];

export interface WebhookEndpoint {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  types?: readonly EventType[];
  labels?: Readonly<Record<string, string>>;
  onlyNeedsAttention?: boolean;
  /** >0: collect events for this long and send them in one delivery. */
  batchMs?: number;
  /** How deliveries are signed. Default "paseo". */
  signature?: SignatureScheme;
}

export interface DeliveryRecord {
  id: string;
  endpointId: string;
  at: string;
  events: number;
  test: boolean;
  status: "delivered" | "failed" | "retrying";
  attempts: number;
  httpStatus: number | null;
  error: string | null;
  ms: number;
}

export interface EndpointStatus {
  paused: boolean;
  consecutiveFailures: number;
  /** Events not sent because the endpoint was paused. */
  dropped: number;
  deliveries: DeliveryRecord[];
}

/** Where pause state lives (the plugin keeps it in its state file). */
export interface PauseStore {
  isPaused(endpointId: string): boolean;
  setPaused(endpointId: string, paused: boolean): void;
}

/** `whsec_` + standard base64 of 24 random bytes: valid for every scheme, also as a Standard Webhooks key. */
export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

/** Why a secret cannot be used with this scheme, or null. Imported secrets (from the receiver) go through this. */
export function checkSecret(secret: string, scheme: SignatureScheme = "paseo"): string | null {
  if (secret.length < 16) return "The secret must have at least 16 characters";
  if (secret.length > 256) return "The secret must have at most 256 characters";
  if (/\s/.test(secret)) return "The secret must not contain whitespace";
  if (scheme === "standard-webhooks" && secret.startsWith("whsec_")) {
    const b64 = secret.slice(6);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
      return "A whsec_ secret must be standard base64 after the prefix (no - or _)";
    }
    if (Buffer.from(b64, "base64").length < 16) return "A whsec_ secret must decode to at least 16 bytes";
  }
  return null;
}

/** checkSecret for a stored secret, phrased for the delivery log and the settings screen. */
export function secretProblem(secret: string, scheme: SignatureScheme = "paseo"): string | null {
  const problem = checkSecret(secret, scheme);
  return problem ? `Secret does not fit the ${scheme} signature (${problem}); rotate or set it` : null;
}

// ---------------------------------------------------------------- paseo scheme

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${sign(secret, timestamp, body)}`;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Receiver side: checks the signature over the raw body and that the timestamp is recent. */
export function verifySignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false;
  return safeEqual(Buffer.from(parts.v1, "hex"), Buffer.from(sign(secret, t, body), "hex"));
}

// ---------------------------------------------------------------- standard-webhooks scheme

/** The HMAC key of a Standard Webhooks secret: base64 after "whsec_", otherwise the secret's own bytes. */
export function standardWebhooksKey(secret: string): Buffer {
  return secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
}

export function standardWebhooksSignature(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac("sha256", standardWebhooksKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** Receiver side for Standard Webhooks: any of the space-separated v1 signatures may match. */
export function verifyStandardWebhook(
  secret: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  body: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const t = Number(headers.timestamp);
  if (!headers.id || !headers.signature || !Number.isInteger(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(standardWebhooksSignature(secret, headers.id, t, body).slice(3), "base64");
  return headers.signature.split(" ").some((entry) => {
    const [version, sig] = entry.split(",", 2);
    return version === "v1" && !!sig && safeEqual(Buffer.from(sig, "base64"), expected);
  });
}

// ---------------------------------------------------------------- github scheme

export function githubSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Receiver side for X-Hub-Signature-256. It carries no timestamp: dedupe by X-GitHub-Delivery. */
export function verifyGithubSignature(secret: string, header: string | null | undefined, body: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(Buffer.from(header.slice(7), "hex"), Buffer.from(githubSignature(secret, body).slice(7), "hex"));
}

/** The headers that sign one attempt of a delivery. */
export function signingHeaders(
  scheme: SignatureScheme,
  secret: string,
  delivery: { id: string; type: string; timestamp: number; body: string },
): Record<string, string> {
  switch (scheme) {
    case "standard-webhooks":
      return {
        "webhook-id": delivery.id,
        "webhook-timestamp": String(delivery.timestamp),
        "webhook-signature": standardWebhooksSignature(secret, delivery.id, delivery.timestamp, delivery.body),
      };
    case "github":
      return {
        "X-Hub-Signature-256": githubSignature(secret, delivery.body),
        "X-GitHub-Event": delivery.type,
        "X-GitHub-Delivery": delivery.id,
      };
    default:
      return { [SIGNATURE_HEADER]: signatureHeader(secret, delivery.timestamp, delivery.body) };
  }
}

// ---------------------------------------------------------------- custom headers

/** Headers a custom header must not replace: transport, body and every signing header of any scheme. */
const RESERVED_HEADERS = new Set(
  [
    "host", "content-type", "content-length", "content-encoding", "transfer-encoding", "connection", "user-agent",
    "expect", "te", "trailer", "upgrade", "keep-alive", "proxy-authorization", "cookie",
    SIGNATURE_HEADER, DELIVERY_HEADER, EVENT_ID_HEADER,
    "webhook-id", "webhook-timestamp", "webhook-signature", "svix-id", "svix-timestamp", "svix-signature",
    "x-hub-signature", "x-hub-signature-256", "x-github-event", "x-github-delivery",
  ].map((h) => h.toLowerCase()),
);

export const MAX_CUSTOM_HEADERS = 10;

/** Why these static headers cannot be sent, or null. Names are compared case-insensitively. */
export function checkCustomHeaders(headers: Readonly<Record<string, string>>): string | null {
  const names = Object.keys(headers);
  if (names.length > MAX_CUSTOM_HEADERS) return `At most ${MAX_CUSTOM_HEADERS} custom headers`;
  const seen = new Set<string>();
  for (const name of names) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) return `Not a valid header name: ${name}`;
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) return `${name} is set by paseo-mcp and cannot be replaced`;
    if (seen.has(lower)) return `${name} appears twice`;
    seen.add(lower);
    const value = headers[name];
    if (typeof value !== "string" || value.length > 1024 || /[\r\n\0]/.test(value)) return `Invalid value for ${name}`;
  }
  return null;
}

// ---------------------------------------------------------------- body

/** The JSON body of a delivery. */
export function deliveryBody(deliveryId: string, sentAt: string, events: readonly AgentEvent[]) {
  const newest = events[events.length - 1];
  const types = new Set(events.map((e) => e.type));
  return {
    delivery_id: deliveryId,
    sent_at: sentAt,
    source: "paseo-mcp",
    version: VERSION,
    /** The event type, or "batch" when a bundled delivery mixes types. */
    type: types.size === 1 ? newest.type : "batch",
    /** One line per event. */
    summary: events.map((e) => e.summary).join("\n"),
    event: newest,
    events,
  };
}

function isPrivateIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  return false;
}

/**
 * https anywhere; plain http only to loopback or private addresses (and localhost), where the
 * traffic stays on the machine or the local network. Returns an error message or null.
 */
export function checkWebhookUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  if (url.username || url.password) return "Put credentials in the secret, not in the URL";
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return "Only https:// or http:// URLs";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || isPrivateIp(host)) return null;
  return "Plain http is only allowed to localhost or private addresses; use https";
}

export interface DispatcherOptions {
  endpoints(): readonly WebhookEndpoint[];
  secret(endpointId: string): string | undefined;
  /** Static extra headers per endpoint (may hold credentials; never logged). */
  headers?(endpointId: string): Readonly<Record<string, string>> | undefined;
  pauses: PauseStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  pauseAfter?: number;
  log?(message: string): void;
  now?: () => number;
}

interface EndpointRuntime {
  consecutiveFailures: number;
  dropped: number;
  deliveries: DeliveryRecord[];
  batch: AgentEvent[];
  batchTimer: ReturnType<typeof setTimeout> | null;
}

const KEEP_DELIVERIES = 20;

export class WebhookDispatcher {
  private readonly runtime = new Map<string, EndpointRuntime>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly sleeping = new Map<ReturnType<typeof setTimeout>, () => void>();
  private stopped = false;

  constructor(private readonly opts: DispatcherOptions) {}

  private rt(id: string): EndpointRuntime {
    let r = this.runtime.get(id);
    if (!r) {
      r = { consecutiveFailures: 0, dropped: 0, deliveries: [], batch: [], batchTimer: null };
      this.runtime.set(id, r);
    }
    return r;
  }

  /** Feeds one event to every matching, enabled endpoint. */
  handle(event: AgentEvent): void {
    if (this.stopped) return;
    for (const endpoint of this.opts.endpoints()) {
      if (!endpoint.enabled) continue;
      if (!matches(event, { types: endpoint.types, labels: endpoint.labels, onlyNeedsAttention: endpoint.onlyNeedsAttention })) continue;
      const r = this.rt(endpoint.id);
      if (this.opts.pauses.isPaused(endpoint.id)) {
        r.dropped++;
        continue;
      }
      if (endpoint.batchMs && endpoint.batchMs > 0) {
        r.batch.push(event);
        r.batchTimer ??= setTimeout(() => {
          r.batchTimer = null;
          const events = r.batch.splice(0);
          if (events.length) this.track(this.deliver(endpoint.id, events, false));
        }, endpoint.batchMs);
      } else {
        this.track(this.deliver(endpoint.id, [event], false));
      }
    }
  }

  /** Sends a test event to one endpoint, ignoring its filters and pause. */
  test(endpointId: string): Promise<DeliveryRecord> {
    const at = new Date(this.now()).toISOString();
    const event = {
      id: `test:${randomBytes(6).toString("hex")}`,
      epoch: "test",
      seq: 0,
      type: "webhook.test",
      at,
      agentId: "test",
      title: "Test event from paseo-mcp",
      status: null,
      labels: {},
      cwd: null,
      provider: null,
      summary: "Test event from paseo-mcp",
      requiresAttention: false,
      attentionReason: null,
      source: "hook",
    } as unknown as AgentEvent;
    return this.track(this.deliver(endpointId, [event], true));
  }

  resume(endpointId: string): void {
    this.opts.pauses.setPaused(endpointId, false);
    const r = this.rt(endpointId);
    r.consecutiveFailures = 0;
    r.dropped = 0;
  }

  status(endpointId: string): EndpointStatus {
    const r = this.rt(endpointId);
    return {
      paused: this.opts.pauses.isPaused(endpointId),
      consecutiveFailures: r.consecutiveFailures,
      dropped: r.dropped,
      deliveries: [...r.deliveries].reverse(),
    };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return p;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.sleeping.delete(t);
        resolve();
      }, ms);
      this.sleeping.set(t, resolve);
    });
  }

  private record(r: EndpointRuntime, d: DeliveryRecord): void {
    const i = r.deliveries.findIndex((x) => x.id === d.id && x.at === d.at);
    if (i >= 0) r.deliveries[i] = d;
    else r.deliveries.push(d);
    if (r.deliveries.length > KEEP_DELIVERIES) r.deliveries.splice(0, r.deliveries.length - KEEP_DELIVERIES);
  }

  private async deliver(endpointId: string, events: AgentEvent[], test: boolean): Promise<DeliveryRecord> {
    const endpoint = this.opts.endpoints().find((e) => e.id === endpointId);
    const r = this.rt(endpointId);
    const deliveryId = events.length === 1 ? events[0].id : `${events[0].id}..${events[events.length - 1].seq}`;
    const record: DeliveryRecord = {
      id: deliveryId,
      endpointId,
      at: new Date(this.now()).toISOString(),
      events: events.length,
      test,
      status: "retrying",
      attempts: 0,
      httpStatus: null,
      error: null,
      ms: 0,
    };
    const secret = this.opts.secret(endpointId);
    if (!endpoint || !secret) {
      record.status = "failed";
      record.error = !endpoint ? "Endpoint not found" : "No secret for this endpoint; rotate it";
      this.record(r, record);
      return record;
    }
    const urlError = checkWebhookUrl(endpoint.url) ?? secretProblem(secret, endpoint.signature);
    if (urlError) {
      record.status = "failed";
      record.error = urlError;
      this.record(r, record);
      return record;
    }
    const payload = deliveryBody(deliveryId, record.at, events);
    const body = JSON.stringify(payload);
    const scheme = endpoint.signature ?? "paseo";
    const custom = this.opts.headers?.(endpointId) ?? {};
    const maxAttempts = test ? 1 : (this.opts.maxAttempts ?? 6);
    const base = this.opts.baseDelayMs ?? 1000;
    const doFetch = this.opts.fetch ?? fetch;
    const started = this.now();

    for (let attempt = 1; attempt <= maxAttempts && !this.stopped; attempt++) {
      record.attempts = attempt;
      const t = Math.floor(this.now() / 1000);
      let retry = false;
      try {
        const res = await doFetch(endpoint.url, {
          method: "POST",
          headers: {
            ...custom,
            "content-type": "application/json",
            "user-agent": `paseo-mcp-webhooks/${VERSION}`,
            ...signingHeaders(scheme, secret, { id: deliveryId, type: payload.type, timestamp: t, body }),
            [DELIVERY_HEADER]: deliveryId,
            [EVENT_ID_HEADER]: events[0].id,
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
        });
        await res.body?.cancel().catch(() => {});
        record.httpStatus = res.status;
        if (res.status >= 200 && res.status < 300) {
          record.status = "delivered";
          record.error = null;
          break;
        }
        record.error = `HTTP ${res.status}`;
        retry = res.status === 408 || res.status === 429 || res.status >= 500;
      } catch (e) {
        record.httpStatus = null;
        record.error = e instanceof Error ? (e.name === "TimeoutError" ? "Timed out" : e.message) : String(e);
        retry = true;
      }
      if (!retry || attempt === maxAttempts) {
        record.status = "failed";
        break;
      }
      this.record(r, { ...record });
      const delay = base * 2 ** (attempt - 1);
      await this.sleep(delay + Math.random() * delay * 0.2);
    }
    record.ms = this.now() - started;
    this.record(r, record);

    if (!test) {
      if (record.status === "delivered") r.consecutiveFailures = 0;
      else if (record.status === "failed") {
        r.consecutiveFailures++;
        if (r.consecutiveFailures >= (this.opts.pauseAfter ?? 5) && !this.opts.pauses.isPaused(endpointId)) {
          this.opts.pauses.setPaused(endpointId, true);
          this.opts.log?.(`webhook "${endpoint.label}" paused after ${r.consecutiveFailures} failed deliveries`);
        }
      }
    }
    return record;
  }

  /** Drops state of endpoints that no longer exist. */
  retain(ids: ReadonlySet<string>): void {
    for (const [id, r] of this.runtime) {
      if (!ids.has(id)) {
        if (r.batchTimer) clearTimeout(r.batchTimer);
        this.runtime.delete(id);
      }
    }
  }

  /** Waits for deliveries in flight (tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  stop(): void {
    this.stopped = true;
    // Wake deliveries waiting for a retry; they see `stopped` and end.
    for (const [t, wake] of this.sleeping) {
      clearTimeout(t);
      wake();
    }
    this.sleeping.clear();
    for (const r of this.runtime.values()) if (r.batchTimer) clearTimeout(r.batchTimer);
  }
}
