// paseo-mcp as a Paseo plugin: the same tools as the stdio server, served over Streamable HTTP
// from inside the daemon and configured on the plugin's settings screen.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { newToken } from "./server/auth.js";
import { createTokenRpc, probeRpc, statusRpc, stdioStatusRpc } from "./shared/rpc.js";
import { mcpSettings } from "./shared/settings.js";
import { McpRuntime } from "./server/plugin/runtime.js";
import { syncLauncher } from "./server/plugin/launcher.js";
import { probe, stdioStatus } from "./server/plugin/stdio.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(mcpSettings);
  const runtime = new McpRuntime();

  const onSettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") return runtime.apply(state.values);
    console.warn(`paseo-mcp: settings are invalid, keeping the previous ones: ${state.error}`);
  };

  const cleanups = [settings.subscribe(onSettings)];
  void runtime.lastUsed
    .load()
    .then(() => settings.read())
    .then(onSettings)
    .catch((e) => console.error({ err: e }, "paseo-mcp: could not read settings"));

  // stdio clients get a stable command that follows plugin updates.
  void syncLauncher()
    .then((state) => {
      if (state.status === "foreign-file") {
        console.warn(`paseo-mcp: ${state.launcherPath} exists and was not written by this plugin; left untouched`);
      } else if (state.status !== "plugin-not-found" && !state.built) {
        console.warn(`paseo-mcp: ${state.entry} is missing; run npm run build in the plugin checkout`);
      } else if (state.status === "written") {
        console.info(`paseo-mcp: launcher written at ${state.launcherPath}`);
      }
    })
    .catch((e) => console.error({ err: e }, "paseo-mcp: could not write the launcher"));

  server.handle(statusRpc, () => runtime.status());
  server.handle(stdioStatusRpc, () => stdioStatus());
  server.handle(probeRpc, async () => {
    const current = await stdioStatus();
    if (!current.command) return { ok: false, tools: null, agents: null, ms: 0, error: "plugin checkout not found" };
    if (!current.built) return { ok: false, tools: null, agents: null, ms: 0, error: "dist/ is missing; run npm run build" };
    return probe(current.command);
  });
  server.handle(createTokenRpc, (input) => newToken(input));

  return async () => {
    for (const cleanup of cleanups) await cleanup();
    await runtime.stop();
  };
}
