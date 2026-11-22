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
import { ClientEventSource, fetchPreview, permissionActions } from "../agent-source.js";
import { WebhookDispatcher, checkCustomHeaders, checkSecret, checkWebhookUrl, generateSecret, secretProblem } from "../webhooks.js";
import { randomUUID } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { isManagedId, loadManaged, managedPath, mergeManaged, type ManagedConfig } from "../managed.js";
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

import { VERSION } from "../version.js";
/** A secret created but not yet saved into the settings survives clean-ups this long. */
const PENDING_SECRET_MS = 10 * 60_000;
/** How often the managed settings file is checked for changes. */
const MANAGED_POLL_MS = 2_000;

function tokenFilter(token: StoredToken): EventFilter | undefined {
  return token.labelFilter && Object.keys(token.labelFilter).length ? { labels: token.labelFilter } : undefined;
}

/** The agent fields every lifecycle hook passes. */
interface HookAgent {
  agentId: string;
  title: string | null;
  cwd?: string | null;
  provider?: string | null;
}

/** What a lifecycle hook reports, in the shape index.server.ts passes on. */
export type HookReport = HookAgent &
  (
    | { hook: "agent.create.after" }
    | { hook: "agent.turn.before" }
    | {
        hook: "agent.turn.after";
        outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };
      }
    | {
        hook: "agent.permission.before";
        request: {
          id: string;
          name?: string | null;
          title?: string | null;
          kind?: string | null;
          description?: string | null;
          actions?: { id: string; label: string; behavior: "allow" | "deny" }[];
        };
      }
    | { hook: "agent.permission.after"; requestId: string; behavior: string | null }
    | { hook: "agent.archive.after" }
    | { hook: "agent.close.after" }
  );

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
    metaLabels: s.metaLabels,
    readOnly: s.readOnly,
  };
}

export class McpRuntime {
  /** What the plugin runs with: the screen's settings merged with the managed file. */
  private settings: McpSettings = McpSettingsSchema.parse({});
  /** The settings document as the screen saved it. */
  private uiSettings: McpSettings = McpSettingsSchema.parse({});
  private managed: ManagedConfig | null = null;
  private managedError: string | null = null;
  private readonly managedFile = managedPath();
  private watching = false;
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
    secret: (id) => this.secretOf(id),
    headers: (id) => (isManagedId(id) ? this.managed?.headers.get(id) : this.state.headers(id)),
    pauses: this.state,
    log: (m) => console.warn(`paseo-mcp: ${m}`),
  });
  private readonly pendingSecrets = new Map<string, number>();
  private hooksSeen = false;

  constructor() {
    this.hub.subscribe((event) => this.webhooks.handle(event));
    // Read before the first settings apply, so the listener does not start twice.
    this.readManaged();
  }

  /** Starts the push source; events flow even while the HTTP server is off (webhooks). */
  start(): void {
    this.source.start();
    if (!this.watching && !this.stopped) {
      this.watching = true;
      watchFile(this.managedFile, { interval: MANAGED_POLL_MS, persistent: false }, () => {
        if (this.readManaged()) void this.enqueue();
      });
    }
  }

  private secretOf(id: string): string | undefined {
    return isManagedId(id) ? this.managed?.secrets.get(id) : this.state.secret(id);
  }

  /** Loads the managed file; an invalid file keeps the previous one. True when something changed. */
  private readManaged(): boolean {
    const result = loadManaged(this.managedFile);
    if (result.status === "invalid") {
      if (this.managedError !== result.error) console.warn(`paseo-mcp: managed settings ignored: ${result.error}`);
      const changed = this.managedError !== result.error;
      this.managedError = result.error;
      return changed;
    }
    this.managedError = null;
    const next = result.status === "ready" ? result.config : null;
    if (next || this.managed) {
      console.info(
        next
          ? `paseo-mcp: managed settings from ${this.managedFile}: ${next.tokens.length} token(s), ${next.webhooks.length} webhook(s)`
          : `paseo-mcp: managed settings file ${this.managedFile} is gone`,
      );
    }
    this.managed = next;
    return true;
  }

  /** Applies a new settings document from the screen. Calls run one after another. */
  apply(next: McpSettings): Promise<void> {
    this.uiSettings = next;
    return this.enqueue();
  }

  private enqueue(): Promise<void> {
    this.queue = this.queue
      .then(() => this.applyNow(mergeManaged(this.uiSettings, this.managed)))
      .catch((e) => {
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
    const base = {
      agentId,
      ...known,
      title: report.title ?? known.title ?? undefined,
      cwd: report.cwd ?? undefined,
      provider: report.provider ?? undefined,
      source: "hook" as const,
    };
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
            ...(report.request.description ? { description: report.request.description } : {}),
            ...(permissionActions(report.request.actions) ? { actions: permissionActions(report.request.actions) } : {}),
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

  createWebhook(
    input: Pick<StoredWebhook, "label" | "url" | "types" | "labels" | "onlyNeedsAttention" | "batchMs"> & {
      signature?: StoredWebhook["signature"];
      secret?: string;
      headers?: Record<string, string>;
    },
  ) {
    const signature = input.signature ?? "paseo";
    const problem =
      checkWebhookUrl(input.url) ??
      (input.secret !== undefined ? checkSecret(input.secret, signature) : null) ??
      (input.headers ? checkCustomHeaders(input.headers) : null);
    if (problem) throw new Error(problem);
    const id = randomUUID();
    const imported = input.secret !== undefined;
    const secret = input.secret ?? generateSecret();
    this.state.setSecret(id, secret);
    if (input.headers) this.state.setHeaders(id, input.headers);
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
      signature,
      secretHint: secret.slice(-4),
      headerNames: Object.keys(input.headers ?? {}),
      createdAt: new Date().toISOString(),
    };
    // An imported secret is the receiver's; it is not sent back to the screen.
    return { secret: imported ? "" : secret, imported, record };
  }

  rotateWebhookSecret(id: string, given?: string) {
    if (isManagedId(id)) throw new Error("This webhook comes from the managed settings file; change it there");
    const webhook = this.settings.webhooks.find((w) => w.id === id);
    if (!webhook) throw new Error("No such webhook");
    if (given !== undefined) {
      const problem = checkSecret(given, webhook.signature);
      if (problem) throw new Error(problem);
    }
    const secret = given ?? generateSecret();
    this.state.setSecret(id, secret);
    return { secret: given !== undefined ? "" : secret, imported: given !== undefined, secretHint: secret.slice(-4) };
  }

  setWebhookHeaders(id: string, headers: Record<string, string>) {
    if (isManagedId(id)) throw new Error("This webhook comes from the managed settings file; change it there");
    if (!this.settings.webhooks.some((w) => w.id === id)) throw new Error("No such webhook; save the settings first");
    const problem = checkCustomHeaders(headers);
    if (problem) throw new Error(problem);
    this.state.setHeaders(id, headers);
    return { headerNames: Object.keys(headers) };
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
      const secret = this.secretOf(w.id);
      webhooks[w.id] = {
        ...this.webhooks.status(w.id),
        hasSecret: Boolean(secret),
        secretError: secret ? secretProblem(secret, w.signature) : null,
      };
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
      managed: {
        path: this.managedFile,
        loaded: this.managed !== null,
        tokens: this.managed?.tokens.length ?? 0,
        webhooks: this.managed?.webhooks.length ?? 0,
        error: this.managedError,
      },
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watching) unwatchFile(this.managedFile);
    this.watching = false;
    await this.queue;
    await this.server?.close();
    this.server = null;
    this.source.stop();
    this.webhooks.stop();
    await this.state.flush();
    await this.daemon.close();
  }
}
