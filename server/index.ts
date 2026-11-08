#!/usr/bin/env node
/**
 * paseo-mcp — MCP server that lets an orchestrator agent (Hermes, Claude, …)
 * see and steer the coding agents managed by a local Paseo daemon.
 *
 * Transport: stdio. Talks to the daemon over its WebSocket API via @getpaseo/client.
 * The same tools also run inside Paseo as a plugin over Streamable HTTP; see ../index.server.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { loadConfig, readLocalCredential, type Config } from "./config.js";
import { errText, registerTools } from "./tools.js";
import { EventHub } from "./events.js";
import { ClientEventSource, fetchPreview } from "./agent-source.js";
import { registerAgentResources } from "./resources.js";

const cfg: Config = loadConfig();

// ---------------------------------------------------------------- connection

let client: PaseoClient | null = null;
let connecting: Promise<PaseoClient> | null = null;

async function paseo(): Promise<PaseoClient> {
  if (client && client.getConnectionState().status === "connected") return client;
  if (connecting) return connecting;
  connecting = (async () => {
    if (client) await client.close().catch(() => {});
    // createPaseoClient passes its config on to DaemonClient, which accepts localCredential;
    // PaseoClientConfig just does not declare it.
    const options: Parameters<typeof createPaseoClient>[0] & {
      localCredential?: () => string | undefined;
    } = {
      url: cfg.daemonUrl,
      password: cfg.password,
      // Without a password, authenticate like the paseo CLI does on this machine. Read on every
      // connect: the daemon rotates it on restart.
      localCredential: cfg.password ? undefined : () => readLocalCredential(cfg.daemonUrl),
      clientId: "paseo-mcp",
      connectTimeoutMs: 10_000,
      reconnect: { enabled: true },
      // stdout belongs to the MCP protocol; keep the SDK quiet.
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
    const c = createPaseoClient(options);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        c.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("connect timed out after 8s")), 8000);
        }),
      ]);
    } catch (e) {
      await c.close().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
    }
    client = c;
    return c;
  })();
  try {
    return await connecting;
  } catch (e) {
    throw new Error(
      `Cannot reach Paseo daemon at ${cfg.daemonUrl}. Is Paseo running? (${errText(e)})`,
    );
  } finally {
    connecting = null;
  }
}

// ---------------------------------------------------------------- server

const hub = cfg.events.enabled
  ? new EventHub({
      capacity: cfg.events.bufferSize,
      ttlMs: cfg.events.ttlMinutes * 60_000,
      previewChars: cfg.events.previewChars,
    })
  : undefined;
// Events start with the server, not with the first tool call, so nothing before it is missed.
const source = hub ? new ClientEventSource({ hub, paseo, preview: fetchPreview }) : undefined;
source?.start();

const server = new McpServer({ name: "paseo", version: "0.3.0" });
if (hub) registerAgentResources(server, { events: hub, paseo });
registerTools(server, { config: () => cfg, paseo, events: hub });

// ---------------------------------------------------------------- start

const transport = new StdioServerTransport();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Don't let a hanging WebSocket close keep the process alive.
  setTimeout(() => process.exit(0), 2000).unref();
  source?.stop();
  await client?.close().catch(() => {});
  process.exit(0);
};
transport.onclose = shutdown;
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(transport);
