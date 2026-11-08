// When each token was last used. The daemon side can read the settings but not write them, so this
// lives in a small file of its own next to the daemon's other state.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paseoHome } from "./daemon.js";

const WRITE_DELAY_MS = 5_000;

export class LastUsedStore {
  private values: Record<string, string> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly path = join(paseoHome(), "paseo-mcp.json");

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as { lastUsed?: Record<string, string> };
      this.values = { ...(raw.lastUsed ?? {}), ...this.values };
    } catch {
      // No file yet.
    }
  }

  all(): Record<string, string> {
    return { ...this.values };
  }

  touch(tokenId: string): void {
    this.values[tokenId] = new Date().toISOString();
    this.timer ??= setTimeout(() => void this.flush(), WRITE_DELAY_MS);
  }

  /** Drops entries of tokens that no longer exist. */
  retain(tokenIds: ReadonlySet<string>): void {
    for (const id of Object.keys(this.values)) {
      if (!tokenIds.has(id)) {
        delete this.values[id];
        this.timer ??= setTimeout(() => void this.flush(), WRITE_DELAY_MS);
      }
    }
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify({ lastUsed: this.values }, null, 2));
      await rename(tmp, this.path);
    } catch (e) {
      console.warn({ err: e }, "paseo-mcp: could not save token usage");
    }
  }
}
