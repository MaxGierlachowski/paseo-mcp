// Applies the settings to the running HTTP server: starts, restarts or stops the listener when
// enable/port/bind change, closes the sessions of revoked tokens, and serves the status the
// settings screen shows. Everything else (roots, accounts, defaults) is read per tool call.
// It also owns the agent events: the EventHub, fed by the lifecycle hooks (index.server.ts) and the
// daemon's push updates, and the webhooks that deliver them.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLoopback } from "../auth.js";
import { ListenError, startHttpServer, type McpHttpServer } from "../http.js";
import { registerTools } from "../tools.js";
import { registerAgentResources } from "../resources.js";
import { EventHub, isLimitError, type EventFilter, type EventInput } from "../events.js";
import { ClientEventSource, fetchPreview } from "../agent-source.js";
import { WebhookDispatcher, checkWebhookUrl, generateSecret } from "../webhooks.js";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { ToolConfig } from "../config.js";
import {
  McpSettingsSchema,
  originFor,
  type McpSettings,
  type StoredToken,
  type StoredWebhook,
} from "../../shared/settings.js";
import type { DeliveryView, McpStatus, WebhookStatusView } from "../../shared/rpc.js";
import { LocalDaemon } from "./daemon.js";
import { PluginState } from "./state.js";

const VERSION = "0.3.0";
/** A secret created but not yet saved into the settings survives clean-ups this long. */
const PENDING_SECRET_MS = 10 * 60_000;

function tokenFilter(token: StoredToken): EventFilter | undefined {
  return token.labelFilter && Object.keys(token.labelFilter).length ? { labels: token.labelFilter } : undefined;
}

/** What a lifecycle hook reports, in the shape index.server.ts passes on. */
export type HookReport =
  | { hook: "agent.create.after"; agentId: string; title: string | null }
  | { hook: "agent.turn.before"; agentId: string; title: string | null }
  | {
      hook: "agent.turn.after";
      agentId: string;
      title: string | null;
      outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };
    }
  | {
      hook: "agent.permission.before";
      agentId: string;
      title: string | null;
      request: { id: string; name?: string | null; title?: string | null; kind?: string | null };
    }
  | { hook: "agent.permission.after"; agentId: string; title: string | null; requestId: string; behavior: string | null }
  | { hook: "agent.archive.after"; agentId: string; title: string | null }
  | { hook: "agent.close.after"; agentId: string; title: string | null };

function listenKey(s: McpSettings): string {
  return s.http.enabled ? `${s.http.bind}|${s.http.port}` : "off";
}

/** Changing a token's scope or hash counts as revoking the old one. */
function tokenKey(t: StoredToken): string {
  return `${t.id}|${t.scope}|${t.hash}`;
}

function toolConfig(s: McpSettings): ToolConfig {
  return {
    allowedRoots: s.allowedRoots,
    accounts: s.accounts,
    defaultAccount: s.defaultAccount || undefined,
    accountEnvVar: s.accountEnvVar,
    defaultProvider: s.defaultProvider || undefined,
    defaultThinking: s.defaultThinking || undefined,
    defaultMode: s.defaultMode || undefined,
    originLabel: s.originLabel || "paseo-mcp",
    readOnly: s.readOnly,
  };
}

export class McpRuntime {
  private settings: McpSettings = McpSettingsSchema.parse({});
  private server: McpHttpServer | null = null;
  private error: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  readonly daemon = new LocalDaemon();
  readonly state = new PluginState();
  readonly hub = new EventHub();
  private readonly source = new ClientEventSource({
    hub: this.hub,
    paseo: () => this.daemon.get(),
    preview: fetchPreview,
    log: (m) => console.warn(`paseo-mcp: ${m}`),
  });
  readonly webhooks = new WebhookDispatcher({
    endpoints: () => this.settings.webhooks,
    secret: (id) => this.state.secret(id),
    pauses: this.state,
    log: (m) => console.warn(`paseo-mcp: ${m}`),
  });
  private readonly pendingSecrets = new Map<string, number>();
  private hooksSeen = false;

  constructor() {
    this.hub.subscribe((event) => this.webhooks.handle(event));
  }

  /** Starts the push source; events flow even while the HTTP server is off (webhooks). */
  start(): void {
    this.source.start();
  }

  /** Applies a new settings document. Calls run one after another. */
  apply(next: McpSettings): Promise<void> {
    this.queue = this.queue.then(() => this.applyNow(next)).catch((e) => {
      console.error({ err: e }, "paseo-mcp: applying settings failed");
    });
    return this.queue;
  }

  private async applyNow(next: McpSettings): Promise<void> {
    if (this.stopped) return;
    const prev = this.settings;
    this.settings = next;

    // A changed label filter also ends the token's sessions, like a changed scope.
    const key = (t: StoredToken) => `${tokenKey(t)}|${JSON.stringify(t.labelFilter ?? {})}`;
    const kept = new Set(next.tokens.map(key));
    const revoked = new Set(prev.tokens.filter((t) => !kept.has(key(t))).map((t) => t.id));
    this.hub.previewChars = next.events.previewChars;
    const now = Date.now();
    for (const [id, at] of this.pendingSecrets) if (now - at > PENDING_SECRET_MS || next.webhooks.some((w) => w.id === id)) this.pendingSecrets.delete(id);
    const webhookIds = new Set([...next.webhooks.map((w) => w.id), ...this.pendingSecrets.keys()]);
    this.state.retain(new Set(next.tokens.map((t) => t.id)), webhookIds);
    this.webhooks.retain(webhookIds);

    if (this.server && listenKey(prev) === listenKey(next) && this.server.port === next.http.port) {
      if (revoked.size) {
        const n = await this.server.closeSessions((id) => revoked.has(id));
        if (n) console.info(`paseo-mcp: closed ${n} session(s) of revoked tokens`);
      }
      // Sessions registered their tool set at start; a readOnly switch needs new sessions.
      if (prev.readOnly !== next.readOnly) await this.server.closeSessions(() => true);
      return;
    }

    if (this.server) {
      await this.server.close();
      this.server = null;
      console.info("paseo-mcp: HTTP server stopped");
    }
    this.error = null;
    if (!next.http.enabled) return;

    const { bind, port } = next.http;
    if (!isLoopback(bind)) {
      console.warn(`paseo-mcp: listening on ${bind}, reachable from other machines; tokens are the only protection`);
    }
    try {
      this.server = await startHttpServer({
        bind,
        port,
        tokens: () => this.settings.tokens,
        onTokenUsed: (t) => this.state.touch(t.id),
        createMcpServer: (token) => this.createMcpServer(token),
        log: (level, message) => (level === "warn" ? console.warn(`paseo-mcp: ${message}`) : console.info(`paseo-mcp: ${message}`)),
      });
      console.info(`paseo-mcp: MCP over HTTP at ${this.server.url}`);
    } catch (e) {
      this.error = e instanceof ListenError ? e.message : `Could not start: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`paseo-mcp: ${this.error}`);
    }
  }

  private createMcpServer(token: StoredToken): McpServer {
    const server = new McpServer({ name: "paseo", version: VERSION });
    const eventFilter = () => tokenFilter(token);
    registerAgentResources(server, { events: this.hub, paseo: () => this.daemon.get(), eventFilter });
    registerTools(server, {
      config: () => toolConfig(this.settings),
      paseo: () => this.daemon.get(),
      scope: token.scope,
      originLabel: () => originFor(token, this.settings),
      events: this.hub,
      eventFilter,
    });
    return server;
  }

  // ---------------------------------------------------------------- hooks

  /**
   * A lifecycle hook fired. The first report of an agent the hub does not know yet fetches its
   * snapshot, so the event carries labels and status (label filters need them).
   */
  async onHook(report: HookReport, paseo: PaseoApi): Promise<void> {
    this.hooksSeen = true;
    const { agentId } = report;
    let known: Pick<EventInput, "labels" | "status" | "title"> = {};
    if (!this.hub.state(agentId)) {
      try {
        const handle = paseo.agents.ref(agentId);
        const agent = (await handle.refresh())?.agent ?? handle.current();
        // The status of a fresh snapshot can lag behind the hook (idle at turn start); only created uses it.
        if (agent) known = { title: agent.title ?? null, labels: agent.labels ?? {}, ...(report.hook === "agent.create.after" ? { status: agent.status } : {}) };
      } catch {
        // Publish what the hook said.
      }
    }
    const base = { agentId, ...known, title: report.title ?? known.title ?? undefined, source: "hook" as const };
    let input: EventInput;
    switch (report.hook) {
      case "agent.create.after":
        input = { ...base, type: "agent.created" };
        break;
      case "agent.turn.before":
        input = { ...base, type: "agent.turn_started" };
        break;
      case "agent.turn.after": {
        const o = report.outcome;
        const error = o.kind === "failed" ? o.error.message : o.kind === "canceled" ? o.reason : null;
        input = {
          ...base,
          type: "agent.turn_ended",
          outcome: o.kind === "completed" ? "finished" : o.kind === "canceled" ? "canceled" : isLimitError(error) ? "limit" : "error",
          error,
        };
        if (this.hub.previewChars > 0 && this.hub.state(agentId)?.inTurn !== false) {
          input.preview = (await fetchPreview(paseo, agentId).catch(() => null)) ?? undefined;
        }
        break;
      }
      case "agent.permission.before":
        input = {
          ...base,
          type: "agent.permission_requested",
          permission: {
            requestId: report.request.id,
            name: report.request.name ?? null,
            title: report.request.title ?? null,
            kind: report.request.kind ?? null,
          },
        };
        break;
      case "agent.permission.after":
        input = {
          ...base,
          type: "agent.permission_resolved",
          permission: { requestId: report.requestId, name: null, title: null, kind: null },
          resolution: report.behavior === "allow" ? "allow" : report.behavior === "deny" ? "deny" : null,
        };
        break;
      case "agent.archive.after":
        input = { ...base, type: "agent.archived" };
        break;
      case "agent.close.after":
        input = { ...base, type: "agent.closed" };
        break;
    }
    this.hub.publish(input);
  }

  // ---------------------------------------------------------------- webhooks

  createWebhook(input: Pick<StoredWebhook, "label" | "url" | "types" | "labels" | "onlyNeedsAttention" | "batchMs">) {
    const urlError = checkWebhookUrl(input.url);
    if (urlError) throw new Error(urlError);
    const id = randomUUID();
    const secret = generateSecret();
    this.state.setSecret(id, secret);
    this.pendingSecrets.set(id, Date.now());
    const record: StoredWebhook = {
      id,
      label: input.label,
      url: input.url,
      enabled: true,
      types: input.types ?? [],
      labels: input.labels ?? {},
      onlyNeedsAttention: input.onlyNeedsAttention ?? false,
      batchMs: input.batchMs ?? 0,
      secretHint: secret.slice(-4),
      createdAt: new Date().toISOString(),
    };
    return { secret, record };
  }

  rotateWebhookSecret(id: string) {
    if (!this.settings.webhooks.some((w) => w.id === id)) throw new Error("No such webhook");
    const secret = generateSecret();
    this.state.setSecret(id, secret);
    return { secret, secretHint: secret.slice(-4) };
  }

  testWebhook(id: string): Promise<DeliveryView> {
    if (!this.settings.webhooks.some((w) => w.id === id)) throw new Error("No such webhook; save the settings first");
    return this.webhooks.test(id);
  }

  resumeWebhook(id: string) {
    this.webhooks.resume(id);
    return { id };
  }

  webhookStatus() {
    const webhooks: Record<string, WebhookStatusView> = {};
    for (const w of this.settings.webhooks) {
      webhooks[w.id] = { ...this.webhooks.status(w.id), hasSecret: Boolean(this.state.secret(w.id)) };
    }
    return {
      webhooks,
      events: { cursor: this.hub.cursor(), sources: [...(this.hooksSeen ? ["hooks"] : []), "push updates"] },
    };
  }

  status(): McpStatus {
    const sessions: Record<string, number> = {};
    for (const t of this.settings.tokens) sessions[t.id] = this.server?.sessionCount(t.id) ?? 0;
    return {
      enabled: this.settings.http.enabled,
      listening: this.server !== null,
      url: this.server?.url ?? null,
      error: this.error,
      sessions,
      lastUsed: this.state.lastUsed(),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.queue;
    await this.server?.close();
    this.server = null;
    this.source.stop();
    this.webhooks.stop();
    await this.state.flush();
    await this.daemon.close();
  }
}
