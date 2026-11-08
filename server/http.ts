/**
 * MCP over Streamable HTTP at /mcp, one McpServer per session. Every request passes, in order:
 * path, Host, Origin, bearer token, body size. Sessions are bound to the token that opened them.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { BoundedEventStore } from "./event-store.js";
import {
  allowedHosts,
  bearerToken,
  checkHost,
  checkOrigin,
  findToken,
  type TokenRecord,
} from "./auth.js";

export const MCP_PATH = "/mcp";
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_IDLE_MS = 60 * 60_000;

export interface HttpServerOptions {
  bind: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Read on every request, so a revoked token stops working at once. */
  tokens(): readonly TokenRecord[];
  /** Builds the MCP server for a new session of this token, with the tools of its scope. */
  createMcpServer(token: TokenRecord): McpServer;
  onTokenUsed?(token: TokenRecord): void;
  log?(level: "info" | "warn", message: string): void;
  maxBodyBytes?: number;
  maxSessions?: number;
  /** Sessions without a request for this long are closed. */
  idleMs?: number;
}

interface Session {
  id: string;
  tokenId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
  inFlight: number;
}

export interface McpHttpServer {
  readonly url: string;
  readonly port: number;
  sessionCount(tokenId?: string): number;
  /** Closes the open sessions of these tokens, e.g. after revoking them. */
  closeSessions(predicate: (tokenId: string) => boolean): Promise<number>;
  close(): Promise<void>;
}

export class ListenError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Starts listening. Rejects with a ListenError (e.g. port in use) instead of throwing later. */
export async function startHttpServer(opts: HttpServerOptions): Promise<McpHttpServer> {
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const log = opts.log ?? (() => {});
  const sessions = new Map<string, Session>();
  let hosts = new Set<string>();

  async function closeSession(s: Session) {
    if (!sessions.delete(s.id)) return;
    await s.transport.close().catch(() => {});
    await s.server.close().catch(() => {});
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? "").split("?", 1)[0];
    if (path !== MCP_PATH) return sendError(res, 404, "Not found");
    if (!checkHost(req.headers.host, hosts)) return sendError(res, 403, "Host not allowed");
    if (!checkOrigin(req.headers.origin, hosts)) return sendError(res, 403, "Origin not allowed");

    const token = findToken(bearerToken(req.headers.authorization), opts.tokens());
    if (!token) {
      return sendError(res, 401, "Missing or invalid bearer token", {
        "www-authenticate": 'Bearer realm="paseo-mcp"',
      });
    }
    opts.onTokenUsed?.(token);

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJson(req, maxBody);
      } catch (e) {
        if (e instanceof BodyTooLarge) return sendError(res, 413, `Request body over ${maxBody} bytes`);
        return sendError(res, 400, "Body is not valid JSON");
      }
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const s = sessions.get(sessionId);
      // A session of another token looks exactly like an unknown one.
      if (!s || s.tokenId !== token.id) return sendError(res, 404, "Session not found");
      s.lastSeen = Date.now();
      s.inFlight++;
      try {
        await s.transport.handleRequest(req, res, body);
      } finally {
        s.inFlight--;
        s.lastSeen = Date.now();
      }
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      return sendError(res, 400, "No session: send an initialize request without Mcp-Session-Id first");
    }
    if (sessions.size >= maxSessions) return sendError(res, 503, "Too many open sessions");

    const server = opts.createMcpServer(token);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Resumable streams: a client that lost its SSE stream reconnects with Last-Event-ID.
      eventStore: new BoundedEventStore(),
      onsessioninitialized: (id) => {
        sessions.set(id, { id, tokenId: token.id, transport, server, lastSeen: Date.now(), inFlight: 0 });
        log("info", `MCP session ${id.slice(0, 8)} opened by token "${token.label}" (${token.scope})`);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.has(id)) {
        sessions.delete(id);
        void server.close().catch(() => {});
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log("warn", `MCP request failed: ${e instanceof Error ? e.message : String(e)}`);
      sendError(res, 500, "Internal error");
    });
  });
  // Long tool calls (paseo_wait_for_agent up to 10 min) and SSE streams must not be cut off.
  http.requestTimeout = 0;
  http.headersTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      http.off("listening", onListening);
      const reason =
        e.code === "EADDRINUSE"
          ? `Port ${opts.port} on ${opts.bind} is already in use`
          : e.code === "EADDRNOTAVAIL"
            ? `${opts.bind} is not an address of this machine`
            : e.code === "EACCES"
              ? `Not allowed to listen on ${opts.bind}:${opts.port}`
              : e.message;
      reject(new ListenError(reason, e.code));
    };
    const onListening = () => {
      http.off("error", onError);
      resolve();
    };
    http.once("error", onError);
    http.once("listening", onListening);
    http.listen(opts.port, opts.bind);
  });
  http.on("error", (e) => log("warn", `HTTP server error: ${e.message}`));

  const port = (http.address() as AddressInfo).port;
  hosts = allowedHosts(opts.bind, port);
  const urlHost = opts.bind === "0.0.0.0" || opts.bind === "::" ? "127.0.0.1" : opts.bind.includes(":") ? `[${opts.bind}]` : opts.bind;

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const s of sessions.values()) {
      if (s.inFlight === 0 && s.lastSeen < cutoff) void closeSession(s);
    }
  }, Math.min(idleMs, 60_000));
  sweeper.unref();

  return {
    url: `http://${urlHost}:${port}${MCP_PATH}`,
    port,
    sessionCount(tokenId) {
      let n = 0;
      for (const s of sessions.values()) if (!tokenId || s.tokenId === tokenId) n++;
      return n;
    },
    async closeSessions(predicate) {
      const doomed = [...sessions.values()].filter((s) => predicate(s.tokenId));
      await Promise.all(doomed.map(closeSession));
      return doomed.length;
    },
    async close() {
      clearInterval(sweeper);
      await Promise.all([...sessions.values()].map(closeSession));
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}
