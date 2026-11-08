// A stable command for stdio clients. Git and npm installs land in a new versioned folder on every
// update, so a client needs one path that follows them: ~/.local/bin/paseo-mcp, rewritten on every
// load to point at the current checkout. It never overwrites a file it did not write.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { expandHome, paseoHome } from "../config.js";

const MANIFEST_ID = "paseo-mcp";
// The same marker as the earlier local plugin, so this one takes over its launcher.
const MARKER = "# managed-by: paseo plugin paseo-mcp";

export type LauncherStatus = "written" | "unchanged" | "foreign-file" | "plugin-not-found";

export interface LauncherState {
  pluginDirectory: string | null;
  launcherPath: string;
  /** dist/index.js of the checkout. */
  entry: string | null;
  built: boolean;
  status: LauncherStatus;
}

export function launcherPath(): string {
  return expandHome(process.env.PASEO_MCP_LAUNCHER ?? "~/.local/bin/paseo-mcp");
}

/**
 * The server bundle is evaluated without a module path, so find this plugin's checkout the way the
 * daemon does: the configured directory whose manifest carries our ID. Git and npm installs are
 * recorded as directory sources too.
 */
export async function findPluginDirectory(): Promise<string | null> {
  let plugins: Record<string, { path?: string }> = {};
  try {
    plugins = JSON.parse(await readFile(path.join(paseoHome(), "config.json"), "utf8")).plugins ?? {};
  } catch {
    return null;
  }
  for (const entry of Object.values(plugins)) {
    if (!entry?.path) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(entry.path, "paseo-plugin.json"), "utf8"));
      if (manifest.id === MANIFEST_ID) return entry.path;
    } catch {
      // Not a readable plugin checkout; keep looking.
    }
  }
  return null;
}

function launcherScript(pluginDirectory: string): string {
  return [
    "#!/bin/sh",
    MARKER,
    "# Rewritten whenever the plugin loads, so it follows updates. Remove it with the plugin.",
    `exec "${path.join(pluginDirectory, "bin", "paseo-mcp")}" "$@"`,
    "",
  ].join("\n");
}

/** Points the launcher at the current checkout. Never overwrites a file it did not write. */
export async function syncLauncher(): Promise<LauncherState> {
  const target = launcherPath();
  const pluginDirectory = await findPluginDirectory();
  if (!pluginDirectory) {
    return { pluginDirectory, launcherPath: target, entry: null, built: false, status: "plugin-not-found" };
  }
  const entry = path.join(pluginDirectory, "dist", "index.js");
  const base = { pluginDirectory, launcherPath: target, entry, built: existsSync(entry) };
  const script = launcherScript(pluginDirectory);
  const current = await readFile(target, "utf8").catch(() => null);
  if (current === script) return { ...base, status: "unchanged" };
  if (current !== null && !current.includes(MARKER)) return { ...base, status: "foreign-file" };
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, script, { mode: 0o755 });
  await chmod(temporary, 0o755);
  await rename(temporary, target);
  return { ...base, status: "written" };
}
