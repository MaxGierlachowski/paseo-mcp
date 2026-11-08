// The tools' connection to the daemon this plugin runs in, made the way the paseo CLI makes it.
//
// The plugin SDK hands out a PaseoApi only inside hook and RPC handlers, scoped to that call. MCP
// requests arrive on our own HTTP listener, outside any handler, so the tools keep one long-lived
// loopback connection instead, authenticated with the local credential the daemon writes to
// $PASEO_HOME/local-credential for local clients. No password or URL has to be configured.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const LockSchema = z.object({ listen: z.string().min(1) });

export function paseoHome(): string {
  return process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
}

/** ws URL of the local daemon, from the lock file it writes on start. */
async function daemonUrl(home: string): Promise<string> {
  const { listen } = LockSchema.parse(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")));
  if (listen.startsWith("/") || listen.includes("://")) {
    throw new Error(`Daemon listens on ${listen}; only host:port is supported`);
  }
  return `ws://${listen}/ws`;
}

const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {}, child() { return quiet; } };

export class LocalDaemon {
  private client: DaemonClient | null = null;
  private api: PaseoApi | null = null;
  private connecting: Promise<PaseoApi> | null = null;

  /** A connected API; connects on first use and again after the connection dropped. */
  async get(): Promise<PaseoApi> {
    if (this.api && this.client?.getConnectionState().status === "connected") return this.api;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<PaseoApi> {
    await this.close();
    const home = paseoHome();
    let url = "the local daemon";
    try {
      url = await daemonUrl(home);
      const token = (await readFile(join(home, "local-credential"), "utf8")).trim();
      const client = new DaemonClient({
        url,
        clientId: "plugin-paseo-mcp",
        clientType: "mcp",
        localCredential: () => token,
        reconnect: { enabled: true },
        connectTimeoutMs: 8_000,
        logger: quiet as never,
      });
      await client.connect();
      this.client = client;
      this.api = createPaseoApi(client);
      return this.api;
    } catch (e) {
      await this.close();
      throw new Error(`Cannot reach Paseo daemon at ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.api = null;
    await client?.close().catch(() => {});
  }
}
