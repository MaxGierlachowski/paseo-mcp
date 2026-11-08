// paseo-mcp as a Paseo plugin: the same tools as the stdio server, served over Streamable HTTP
// from inside the daemon and configured on the plugin's settings screen.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { newToken } from "./server/auth.js";
import { createTokenRpc, statusRpc } from "./shared/rpc.js";
import { mcpSettings } from "./shared/settings.js";
import { McpRuntime } from "./server/plugin/runtime.js";

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

  server.handle(statusRpc, () => runtime.status());
  server.handle(createTokenRpc, (input) => newToken(input));

  return async () => {
    for (const cleanup of cleanups) await cleanup();
    await runtime.stop();
  };
}
