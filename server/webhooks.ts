/**
 * Webhooks (plugin mode): POSTs agent events to configured endpoints.
 *
 * Body: {"delivery_id", "sent_at", "events": [AgentEvent, ...]}. Headers:
 *   Paseo-Mcp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *   Paseo-Mcp-Delivery:  delivery id, the same on every retry (use it for idempotency)
 *   Paseo-Mcp-Event-Id:  id of the first event (single-event deliveries: the event's id)
 * Retries with exponential backoff on network errors, timeouts, 408, 429 and 5xx. After
 * `pauseAfter` failed deliveries in a row the endpoint pauses until resumed.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { matches, type AgentEvent, type EventType } from "./events.js";

export const SIGNATURE_HEADER = "Paseo-Mcp-Signature";
export const DELIVERY_HEADER = "Paseo-Mcp-Delivery";
export const EVENT_ID_HEADER = "Paseo-Mcp-Event-Id";

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

export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${sign(secret, timestamp, body)}`;
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
  const expected = Buffer.from(sign(secret, t, body), "hex");
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
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
    const urlError = checkWebhookUrl(endpoint.url);
    if (urlError) {
      record.status = "failed";
      record.error = urlError;
      this.record(r, record);
      return record;
    }
    const body = JSON.stringify({ delivery_id: deliveryId, sent_at: record.at, events });
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
            "content-type": "application/json",
            "user-agent": "paseo-mcp-webhooks",
            [SIGNATURE_HEADER]: signatureHeader(secret, t, body),
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
