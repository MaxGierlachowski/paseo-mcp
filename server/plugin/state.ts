// Daemon-side state the settings must not hold: when each token was last used, webhook secrets and
// which webhooks are paused. The daemon side can read the settings but not write them, and secrets
// do not belong in a document every connected app can read. One file next to the daemon's other
// state, readable by the owner only.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paseoHome } from "../config.js";
import type { PauseStore } from "../webhooks.js";

const WRITE_DELAY_MS = 5_000;

interface StateFile {
  lastUsed: Record<string, string>;
  webhookSecrets: Record<string, string>;
  webhookPaused: Record<string, boolean>;
}

export class PluginState implements PauseStore {
  private data: StateFile = { lastUsed: {}, webhookSecrets: {}, webhookPaused: {} };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly path = join(paseoHome(), "paseo-mcp.json");

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<StateFile>;
      this.data = {
        lastUsed: { ...(raw.lastUsed ?? {}), ...this.data.lastUsed },
        webhookSecrets: { ...(raw.webhookSecrets ?? {}), ...this.data.webhookSecrets },
        webhookPaused: { ...(raw.webhookPaused ?? {}), ...this.data.webhookPaused },
      };
    } catch {
      // No file yet.
    }
  }

  private changed(soon = false): void {
    if (soon) {
      void this.flush();
      return;
    }
    this.timer ??= setTimeout(() => void this.flush(), WRITE_DELAY_MS);
  }

  // ---- tokens

  lastUsed(): Record<string, string> {
    return { ...this.data.lastUsed };
  }

  touch(tokenId: string): void {
    this.data.lastUsed[tokenId] = new Date().toISOString();
    this.changed();
  }

  // ---- webhooks

  secret(webhookId: string): string | undefined {
    return this.data.webhookSecrets[webhookId];
  }

  setSecret(webhookId: string, secret: string): void {
    this.data.webhookSecrets[webhookId] = secret;
    this.changed(true);
  }

  isPaused(webhookId: string): boolean {
    return this.data.webhookPaused[webhookId] === true;
  }

  setPaused(webhookId: string, paused: boolean): void {
    if (paused) this.data.webhookPaused[webhookId] = true;
    else delete this.data.webhookPaused[webhookId];
    this.changed(true);
  }

  /** Drops entries of tokens and webhooks that no longer exist. */
  retain(tokenIds: ReadonlySet<string>, webhookIds: ReadonlySet<string>): void {
    let dirty = false;
    for (const id of Object.keys(this.data.lastUsed)) if (!tokenIds.has(id)) (delete this.data.lastUsed[id], (dirty = true));
    for (const id of Object.keys(this.data.webhookSecrets)) if (!webhookIds.has(id)) (delete this.data.webhookSecrets[id], (dirty = true));
    for (const id of Object.keys(this.data.webhookPaused)) if (!webhookIds.has(id)) (delete this.data.webhookPaused[id], (dirty = true));
    if (dirty) this.changed();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
    } catch (e) {
      console.warn({ err: e }, "paseo-mcp: could not save plugin state");
    }
  }
}
