// Applies the settings to the running HTTP server: starts, restarts or stops the listener when
// enable/port/bind change, closes the sessions of revoked tokens, and serves the status the
// settings screen shows. Everything else (roots, accounts, defaults) is read per tool call.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLoopback } from "../auth.js";
import { ListenError, startHttpServer, type McpHttpServer } from "../http.js";
import { registerTools } from "../tools.js";
import type { ToolConfig } from "../config.js";
import { McpSettingsSchema, originFor, type McpSettings, type StoredToken } from "../../shared/settings.js";
import type { McpStatus } from "../../shared/rpc.js";
import { LocalDaemon } from "./daemon.js";
import { LastUsedStore } from "./state.js";

const VERSION = "0.2.0";

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
  readonly lastUsed = new LastUsedStore();

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

    const kept = new Set(next.tokens.map(tokenKey));
    const revoked = new Set(prev.tokens.filter((t) => !kept.has(tokenKey(t))).map((t) => t.id));
    this.lastUsed.retain(new Set(next.tokens.map((t) => t.id)));

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
        onTokenUsed: (t) => this.lastUsed.touch(t.id),
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
    registerTools(server, {
      config: () => toolConfig(this.settings),
      paseo: () => this.daemon.get(),
      scope: token.scope,
      originLabel: () => originFor(token, this.settings),
    });
    return server;
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
      lastUsed: this.lastUsed.all(),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.queue;
    await this.server?.close();
    this.server = null;
    await this.lastUsed.flush();
    await this.daemon.close();
  }
}
